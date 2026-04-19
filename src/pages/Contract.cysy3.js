import wixLocation from "wix-location";
import {
  getContract,
  saveContract as saveContractBackend,
  confirmBookingAnalysis,
  getCustomerInsights,
  getCompanyInsights,
  exportContractRenderedDocument,
  exportContractPdfFromHtml,
  getContractDocumentRenderCapabilities
} from "backend/rentalContract";
import { setBookingBoardStatus } from "backend/bookingsBoard";
import { getPricingCatalog } from 'backend/pricingCatalog';
import { logoutBackroom, requireBackroomAccess } from 'public/backroomAuth';
import { isTrustedBridgeOrigin, normalizeBridgeMessage, postMessageSafe, resolveHtmlComponent } from "public/bridgeUtils";
import { APP_ROUTES as ROUTES } from "public/appRoutes";
import { collapseHtmlSiblings } from "public/pageVisibility";

const CONTRACT_HTML_ID = "#contractHtml";

let bookingId = "";
let returnTab = "daily";
let currentUserLabel = "Operator";
let pageMode = "ops";
let returnDate = "";
let returnStartDate = "";
let returnEndDate = "";
let authState = null;
let htmlComponent = null;

function logSuppressed(context, error) {
  console.warn(`[Contract] ${context}`, error?.message || error || 'unknown error');
}

function getHtmlComponent() {
  return resolveHtmlComponent($w, [CONTRACT_HTML_ID]);
}

function normalizeIncomingMessage(event) {
  if (event && !isTrustedBridgeOrigin(event?.origin, wixLocation.url)) return null;
  const msg = normalizeBridgeMessage(event && event.data);
  return msg && typeof msg === "object" ? msg : null;
}

$w.onReady(async function () {
  authState = await requireBackroomAccess({ area: "rentals", action: "View" });
  if (!authState?.ok) return;
  hideNonContractComponents([CONTRACT_HTML_ID]);

  const query = wixLocation.query || {};
  bookingId = String(query.bookingId || query.id || "").trim();
  returnTab = String(query.from || query.tab || "daily").trim() || "daily";
  pageMode = String(query.mode || "ops").trim() === "analysis" ? "analysis" : "ops";
  returnDate = normalizeDate(String(query.date || "").trim());
  returnStartDate = normalizeDate(String(query.startDate || "").trim());
  returnEndDate = normalizeDate(String(query.endDate || "").trim());
  currentUserLabel = authState.fullName || authState.email || currentUserLabel;

  htmlComponent = getHtmlComponent();
  if (!htmlComponent) {
    post({ type: "toast", message: "Contract bridge unavailable." });
    return;
  }

  htmlComponent.onMessage(async (event) => {
    const msg = normalizeIncomingMessage(event);
    if (!msg || !msg.type) return;

    if (msg.type === "contractReady") {
      await loadContract();
      return;
    }

    if (msg.type === "reloadContract") {
      await loadContract();
      return;
    }

    if (msg.type === "fetchCustomerInsights") {
      await fetchCustomerInsightsFlow(msg);
      return;
    }

    if (msg.type === "fetchCompanyInsights") {
      await fetchCompanyInsightsFlow(msg);
      return;
    }

    if (msg.type === "saveContract") {
      await saveContractFlow(msg);
      return;
    }
    if (msg.type === "documentAction") {
      await documentActionFlow(msg);
      return;
    }

    if (msg.type === "confirmBooking") {
      await confirmBookingFlow();
      return;
    }

    if (msg.type === "setBookingStatus") {
      await setBookingStatusFlow(msg);
      return;
    }

    if (msg.type === "openOnBookings") {
      navigateToBookings(msg);
      return;
    }

    if (msg.type === "openOnFleet") {
      navigateToFleet(msg);
      return;
    }

    if (msg.type === "openOnDaily") {
      navigateToDaily(msg);
      return;
    }

    if (msg.type === "openBookingContract") {
      const nextBookingId = String(msg.bookingId || "").trim();
      if (!nextBookingId) return;
      const params = buildBaseParams();
      params.set("bookingId", nextBookingId);
      wixLocation.to(`${getCurrentPageRoute()}?${params.toString()}`);
      return;
    }

    if (msg.type === "openVehicleCard") {
      const fleetVehicleId = String(msg.fleetVehicleId || msg.vehicleId || "").trim();
      if (!fleetVehicleId) return;
      wixLocation.to(`${ROUTES.vehiclecard}?fleetVehicleId=${encodeURIComponent(fleetVehicleId)}`);
      return;
    }

    if (msg.type === "back") {
      wixLocation.to(buildReturnRoute(returnTab));
      return;
    }

    if (msg.type === "navigate") {
      wixLocation.to(buildReturnRoute(String(msg.route || "").trim() || returnTab));
      return;
    }

    if (msg.type === "logout") {
      await logoutBackroom();
      wixLocation.to(ROUTES.home);
      return;
    }

    if (msg.type === "resize") {
      const nextHeight = Math.max(1200, Math.min(Number(msg.height || 0) || 0, 5000));
      try { htmlComponent.height = nextHeight; } catch (error) { logSuppressed('resize height set failed', error); }
      return;
    }
  });

  if (!bookingId) {
    post({ type: "toast", message: "Missing bookingId in URL." });
  }
});

function hideNonContractComponents(keepIds) {
  collapseHtmlSiblings($w, keepIds);
}

async function loadContract() {
  if (!bookingId) {
    post({ type: "toast", message: "Cannot load contract: missing bookingId." });
    return;
  }

  try {
    const [res, pricingCatalog] = await Promise.all([
      getContract({ authToken: authState.sessionToken, bookingId }),
      getPricingCatalog({ scope: 'all' }).catch(() => null)
    ]);
    if (!res?.success) {
      post({ type: "toast", message: res?.message || "Failed to load contract." });
      return;
    }

    const pickupLocations = Array.isArray(pricingCatalog?.pickupLocations)
      ? pricingCatalog.pickupLocations.filter((row) => row && row.active !== false)
      : [];
    const insurancePlans = Array.isArray(pricingCatalog?.insurancePlans)
      ? pricingCatalog.insurancePlans.filter((row) => row && row.active !== false)
      : [];
    const extraServices = Array.isArray(pricingCatalog?.extraServices)
      ? pricingCatalog.extraServices.filter((row) => row && row.active !== false)
      : [];
    const feeRules = Array.isArray(pricingCatalog?.feeRules)
      ? pricingCatalog.feeRules.filter((row) => row && row.active !== false)
      : [];

    post({
      type: "loadContractData",
      booking: clonePlain(res.booking || {}),
      rental: normalizeRentalDraft(clonePlain(res.rental || {})),
      lookups: clonePlain({ ...(res.lookups || {}), pickupLocations, insurancePlans, extraServices, feeRules }),
      context: {
        user: currentUserLabel,
        from: returnTab,
        company: pricingCatalog?.businessSettings?.companyName || "Diamond Rent A Car",
        mode: pageMode,
        permissions: {
          isAdmin: !!authState?.isAdmin,
          canOverridePricing: !!(authState?.isAdmin || (authState?.specialPermissions || []).includes("overridePricing")),
          canApproveManualOverride: !!(authState?.isAdmin || (authState?.specialPermissions || []).includes("approveManualOverride")),
          canCancelBooking: !!(authState?.isAdmin || (authState?.specialPermissions || []).includes("cancelBooking"))
        }
      }
    });
  } catch (err) {
    post({ type: "toast", message: err?.message || String(err) });
  }
}


async function fetchCustomerInsightsFlow(msg) {
  try {
    const res = await getCustomerInsights({
      authToken: authState.sessionToken,
      customer: clonePlain(msg.payload || {}),
      limit: 80
    });
    post({
      type: 'customerInsightsData',
      requestId: String(msg.requestId || ''),
      data: res?.success ? clonePlain({ profile: res.profile || {}, summary: res.summary || {}, history: res.history || [] }) : null,
      message: res?.message || ''
    });
  } catch (err) {
    post({ type:'customerInsightsData', requestId: String(msg.requestId || ''), data: null, message: err?.message || String(err) });
  }
}

async function fetchCompanyInsightsFlow(msg) {
  try {
    const res = await getCompanyInsights({
      authToken: authState.sessionToken,
      company: clonePlain(msg.payload || {}),
      limit: 80
    });
    post({
      type: 'companyInsightsData',
      requestId: String(msg.requestId || ''),
      data: res?.success ? clonePlain({ profile: res.profile || {}, summary: res.summary || {}, history: res.history || [] }) : null,
      message: res?.message || ''
    });
  } catch (err) {
    post({ type:'companyInsightsData', requestId: String(msg.requestId || ''), data: null, message: err?.message || String(err) });
  }
}

async function saveContractFlow(msg) {
  const id = String(msg.bookingId || bookingId || "").trim();
  if (!id) {
    post({ type: "toast", message: "Cannot save: missing bookingId." });
    return;
  }

  try {
    const payload = normalizePayload(msg.payload || {});
    const res = await saveContractBackend({
      authToken: authState.sessionToken,
      bookingId: id,
      payload,
      stage: String(msg.stage || "")
    });

    if (!res?.success) {
      post({ type: "toast", message: res?.message || "Save failed." });
      return;
    }

    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    post({ type: "saveState", message: res.warning || "Saved ✅", at: `${hh}:${mm}` });

    await loadContract();
  } catch (err) {
    post({ type: "toast", message: err?.message || String(err) });
  }
}

async function documentActionFlow(msg) {
  const id = String(msg.bookingId || bookingId || "").trim();
  const documentType = String(msg.documentType || "agreement").trim().toLowerCase();
  const requestId = String(msg.requestId || "");
  const action = String(msg.action || "preview").trim().toLowerCase();
  if (!id) {
    post({ type: "documentActionResult", requestId, success: false, message: "Missing bookingId." });
    return;
  }
  try {
    if (action === "capabilities") {
      const cap = await getContractDocumentRenderCapabilities({ authToken: authState.sessionToken });
      post({
        type: "documentActionResult",
        requestId,
        success: !!cap?.success,
        action,
        capabilities: clonePlain(cap?.capabilities || {}),
        message: cap?.message || ""
      });
      return;
    }
    if (action === "pdf") {
      const pdf = await exportContractPdfFromHtml({ authToken: authState.sessionToken, bookingId: id, documentType });
      post({
        type: "documentActionResult",
        requestId,
        success: !!pdf?.success,
        action,
        documentType,
        filename: pdf?.filename || "",
        pdfBase64: pdf?.pdfBase64 || "",
        renderEngine: pdf?.renderEngine || "",
        fidelity: pdf?.fidelity || "",
        fallbackUsed: !!pdf?.fallbackUsed,
        fallbackReason: pdf?.fallbackReason || "",
        capabilities: clonePlain(pdf?.capabilitySnapshot || {}),
        message: pdf?.message || ""
      });
      return;
    }
    const rendered = await exportContractRenderedDocument({ authToken: authState.sessionToken, bookingId: id, documentType });
    post({
      type: "documentActionResult",
      requestId,
      success: !!rendered?.success,
      action: "preview",
      documentType,
      html: rendered?.html || "",
      package: clonePlain(rendered?.package || {}),
      printable: clonePlain(rendered?.printable || {}),
      message: rendered?.message || ""
    });
  } catch (err) {
    post({ type: "documentActionResult", requestId, success: false, action, message: err?.message || String(err) });
  }
}

async function confirmBookingFlow() {
  if (!bookingId) {
    post({ type: "toast", message: "Cannot confirm: missing bookingId." });
    return;
  }
  try {
    const res = await confirmBookingAnalysis({ authToken: authState.sessionToken, bookingId });
    if (!res?.success) {
      post({ type: "toast", message: res?.message || "Confirm failed." });
      return;
    }
    post({ type: "saveState", message: res?.message || "Booking confirmed" });
    await loadContract();
  } catch (err) {
    post({ type: "toast", message: err?.message || String(err) });
  }
}

async function setBookingStatusFlow(msg) {
  if (!bookingId) {
    post({ type: "toast", message: "Cannot update status: missing bookingId." });
    return;
  }
  const newStatus = String(msg?.newStatus || "").trim();
  if (!newStatus) return;
  try {
    const res = await setBookingBoardStatus({ authToken: authState.sessionToken, bookingId, newStatus });
    if (!res?.success) {
      post({ type: "toast", message: res?.message || "Status update failed." });
      return;
    }
    post({ type: "saveState", message: res?.message || `Status: ${newStatus}` });
    await loadContract();
  } catch (err) {
    post({ type: "toast", message: err?.message || String(err) });
  }
}

function navigateToBookings(msg) {
  const params = new URLSearchParams();
  const targetBookingId = String(msg.bookingId || bookingId || "").trim();
  const startDate = normalizeDate(String(msg.startDate || "").trim()) || returnStartDate;
  const endDate = normalizeDate(String(msg.endDate || "").trim()) || returnEndDate;
  if (targetBookingId) params.set("bookingId", targetBookingId);
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  wixLocation.to(`${ROUTES.bookings}?${params.toString()}`);
}

function navigateToFleet(msg) {
  const params = new URLSearchParams();
  const targetBookingId = String(msg.bookingId || bookingId || "").trim();
  const startDate = normalizeDate(String(msg.startDate || "").trim()) || returnStartDate;
  const endDate = normalizeDate(String(msg.endDate || "").trim()) || returnEndDate;
  if (targetBookingId) params.set("bookingId", targetBookingId);
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  params.set("from", "contract");
  wixLocation.to(`${ROUTES.fleet}?${params.toString()}`);
}

function navigateToDaily(msg) {
  const params = new URLSearchParams();
  const targetBookingId = String(msg.bookingId || bookingId || "").trim();
  const date = normalizeDate(String(msg.date || "").trim()) || returnDate;
  if (targetBookingId) params.set("bookingId", targetBookingId);
  if (date) params.set("date", date);
  wixLocation.to(`${ROUTES.daily}?${params.toString()}`);
}

function buildReturnRoute(route) {
  const key = String(route || "").trim() || returnTab || "daily";
  const base = ROUTES[key] || ROUTES.daily;
  const params = new URLSearchParams();

  if (key === "daily" && returnDate) params.set("date", returnDate);

  if (key === "bookings" || key === "fleet") {
    if (bookingId) params.set("bookingId", bookingId);
    if (returnStartDate) params.set("startDate", returnStartDate);
    if (returnEndDate) params.set("endDate", returnEndDate);
  }

  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function buildBaseParams() {
  const params = new URLSearchParams();
  params.set("from", returnTab || "daily");
  params.set("mode", pageMode);
  if (returnDate) params.set("date", returnDate);
  if (returnStartDate) params.set("startDate", returnStartDate);
  if (returnEndDate) params.set("endDate", returnEndDate);
  return params;
}

function getCurrentPageRoute() {
  const path = Array.isArray(wixLocation.path) ? wixLocation.path.filter(Boolean) : [];
  return path.length ? `/${path.join("/")}` : "/contract";
}

function normalizeDate(value) {
  const raw = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function normalizeRentalDraft(rental) {
  const draft = rental && typeof rental === "object" ? rental : {};
  const financials = draft.financials && typeof draft.financials === "object" ? draft.financials : {};
  draft.financials = {
    paymentMethod: safeText(financials.paymentMethod || draft.paymentMethod || "cash"),
    paymentStatus: safeText(financials.paymentStatus || draft.paymentStatus || "pending"),
    collectionMode: safeText(financials.collectionMode || draft.collectionMode || "pay_arrival"),
    prepaid: toNumber(financials.prepaid ?? draft.prepaidAmount ?? 0),
    paidNow: toNumber(financials.paidNow ?? draft.paidNowAmount ?? 0),
    deposit: toNumber(financials.deposit ?? draft.depositAmount ?? 0)
  };
  draft.financialTransactions = Array.isArray(draft.financialTransactions) ? draft.financialTransactions : [];
  draft.chargeLines = Array.isArray(draft.chargeLines) ? draft.chargeLines : [];
  return draft;
}

function normalizePayload(payload) {
  const draft = payload && typeof payload === "object" ? payload : {};
  const normalized = {
    ...draft,
    bookingNumber: safeText(draft.bookingNumber),
    bookingStatus: safeText(draft.bookingStatus),
    customerName: safeText(draft.customerName),
    phone: safeText(draft.phone),
    email: safeText(draft.email),
    category: safeText(draft.category),
    categoryId: safeText(draft.categoryId),
    flightNumber: safeText(draft.flightNumber),
    voucherNumber: safeText(draft.voucherNumber),
    confirmationNumber: safeText(draft.confirmationNumber),
    originCity: safeText(draft.originCity),
    customerCity: safeText(draft.customerCity),
    pickuppoint: safeText(draft.pickuppoint),
    dropoffpoint: safeText(draft.dropoffpoint),
    pickupComment: safeText(draft.pickupComment),
    dropoffComment: safeText(draft.dropoffComment),
    selectedPackage: safeText(draft.selectedPackage),
    selectedExtras: Array.isArray(draft.selectedExtras) ? draft.selectedExtras : [],
    assignedVehicle: safeText(draft.assignedVehicle),
    assignedVehicleLabel: safeText(draft.assignedVehicleLabel),
    assignedVehiclePlate: safeText(draft.assignedVehiclePlate),
    assignedVehicleModel: safeText(draft.assignedVehicleModel),
    assignedCategoryCode: safeText(draft.assignedCategoryCode),
    checkoutOdometer: toNumber(draft.checkoutOdometer),
    checkinOdometer: toNumber(draft.checkinOdometer),
    checkoutFuelLevel: toNumber(draft.checkoutFuelLevel),
    checkinFuelLevel: toNumber(draft.checkinFuelLevel),
    checkoutNotes: safeText(draft.checkoutNotes),
    checkinNotes: safeText(draft.checkinNotes),
    damagesNotes: safeText(draft.damagesNotes),
    photos: draft.photos,
    internalMemo: safeText(draft.internalMemo),
    charges: normalizeCharges(draft.charges),
    chargeLines: Array.isArray(draft.chargeLines) ? draft.chargeLines.map(normalizeChargeLine).filter(Boolean) : [],
    billing: normalizeBilling(draft.billing),
    financialTransactions: Array.isArray(draft.financialTransactions) ? draft.financialTransactions.map(normalizeFinancialTransaction).filter(Boolean) : [],
    commercialState: normalizeCommercialState(draft.commercialState),
    checkoutGuardrailOverride: normalizeCheckoutGuardrailOverride(draft.checkoutGuardrailOverride),
    signatureState: normalizeSignatureState(draft.signatureState),
    mainDriver: normalizeDriver(draft.mainDriver),
    additionalDrivers: Array.isArray(draft.additionalDrivers) ? draft.additionalDrivers.map(normalizeDriver).filter(Boolean) : []
  };

  if (draft.pickupDateTime) normalized.pickupDateTime = new Date(draft.pickupDateTime);
  if (draft.dropoffDateTime) normalized.dropoffDateTime = new Date(draft.dropoffDateTime);

  // Companion payload for future backend persistence.
  normalized.financials = normalizeFinancials(draft.financials);
  return normalized;
}

function normalizeDriver(driver) {
  if (!driver || typeof driver !== "object") return null;
  return {
    fullName: safeText(driver.fullName),
    phone: safeText(driver.phone),
    email: safeText(driver.email),
    licenseNo: safeText(driver.licenseNo),
    licenseCountry: safeText(driver.licenseCountry),
    licenseExpiry: safeText(driver.licenseExpiry),
    idNo: safeText(driver.idNo),
    idCountry: safeText(driver.idCountry),
    dob: safeText(driver.dob),
    address: safeText(driver.address),
    notes: safeText(driver.notes)
  };
}

function normalizeFinancialTransaction(tx) {
  if (!tx || typeof tx !== "object") return null;
  return {
    id: safeText(tx.id),
    type: safeText(tx.type),
    category: safeText(tx.category),
    amount: toNumber(tx.amount),
    signedAmount: toNumber(tx.signedAmount),
    at: tx.at ? new Date(tx.at) : null,
    method: safeText(tx.method),
    party: safeText(tx.party),
    reference: safeText(tx.reference),
    receiptNo: safeText(tx.receiptNo),
    terminal: safeText(tx.terminal),
    station: safeText(tx.station),
    user: safeText(tx.user),
    notes: safeText(tx.notes),
    status: safeText(tx.status || "posted")
  };
}

function normalizeChargeLine(line) {
  if (!line || typeof line !== "object") return null;
  const amount = toNumber(line.amount ?? line.value ?? line.absAmount);
  return {
    id: safeText(line.id),
    code: safeText(line.code),
    key: safeText(line.key),
    label: safeText(line.label),
    category: safeText(line.category),
    amount,
    absAmount: Math.abs(amount),
    sign: toNumber(line.sign, amount < 0 ? -1 : 1),
    derived: !!line.derived,
    editable: line.editable !== false,
    source: safeText(line.source),
    notes: safeText(line.notes),
    order: toNumber(line.order),
    taxable: line.taxable !== false
  };
}

function normalizeCommercialState(state) {
  const draft = state && typeof state === "object" ? state : {};
  return {
    paymentStatus: safeText(draft.paymentStatus),
    settlementState: safeText(draft.settlementState),
    outstanding: toNumber(draft.outstanding),
    paidTotal: toNumber(draft.paidTotal),
    notes: safeText(draft.notes)
  };
}

function normalizeCheckoutGuardrailOverride(raw) {
  if (!raw || typeof raw !== "object") return null;
  const reason = safeText(raw.reason || raw.note || "");
  if (!reason) return null;
  return {
    reason,
    actor: safeText(raw.actor || raw.user || ""),
    updatedAt: safeText(raw.updatedAt || raw.at || "")
  };
}

function normalizeSignatureState(raw) {
  if (!raw || typeof raw !== "object") return null;
  const status = safeText(raw.status || raw.state || "not_started").toLowerCase();
  return {
    status: ["not_started", "pending", "captured", "waived"].includes(status) ? status : "not_started",
    signerName: safeText(raw.signerName || raw.customerName || ""),
    signedAt: safeText(raw.signedAt || raw.at || ""),
    note: safeText(raw.note || raw.reason || ""),
    actor: safeText(raw.actor || raw.user || ""),
    updatedAt: safeText(raw.updatedAt || "")
  };
}

function normalizeBilling(billing) {
  const draft = billing && typeof billing === "object" ? billing : {};
  return {
    vatRate: toNumber(draft.vatRate, 0.24),
    vatInclusive: draft.vatInclusive !== false,
    invoiceType: safeText(draft.invoiceType),
    vatNumber: safeText(draft.vatNumber),
    companyName: safeText(draft.companyName),
    profession: safeText(draft.profession),
    taxOffice: safeText(draft.taxOffice),
    address: safeText(draft.address),
    city: safeText(draft.city),
    zip: safeText(draft.zip),
    country: safeText(draft.country),
    phone: safeText(draft.phone),
    companyEmail: safeText(draft.companyEmail)
  };
}

function normalizeFinancials(financials) {
  const draft = financials && typeof financials === "object" ? financials : {};
  return {
    paymentMethod: safeText(draft.paymentMethod || "cash"),
    paymentStatus: safeText(draft.paymentStatus || "pending"),
    collectionMode: safeText(draft.collectionMode || "pay_arrival"),
    prepaid: toNumber(draft.prepaid),
    paidNow: toNumber(draft.paidNow),
    deposit: toNumber(draft.deposit)
  };
}

function normalizeCharges(charges) {
  const draft = charges && typeof charges === "object" ? charges : {};
  return {
    rental: toNumber(draft.rental),
    insurance: toNumber(draft.insurance),
    options: toNumber(draft.options),
    ageFee: toNumber(draft.ageFee),
    nightFee: toNumber(draft.nightFee),
    transport: toNumber(draft.transport),
    damages: toNumber(draft.damages),
    surcharges: toNumber(draft.surcharges),
    discount: toNumber(draft.discount)
  };
}

function safeText(value) {
  return (value ?? "").toString().trim();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function post(msg) {
  if (!htmlComponent) htmlComponent = getHtmlComponent();
  if (!htmlComponent) return;
  if (!postMessageSafe(htmlComponent, msg, 'contract')) logSuppressed('postMessage failed');
}

function clonePlain(v) {
  return JSON.parse(JSON.stringify(v));
}
