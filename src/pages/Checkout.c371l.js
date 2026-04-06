import wixLocation from "wix-location";
import { currentMember } from "wix-members-frontend";
import { getPublicPricingCatalog } from "backend/pricingCatalog.jsw";
import { getVehicleCategoryDetails, createBooking } from "backend/bookingEngine";
import { BRIDGE_TYPES, buildBookingContext, normalizeBridgeMessage, postMessageSafe, resolveHtmlComponent } from "public/bridgeUtils";

const COMPONENT_CANDIDATES = ["#bpage4", "#checkoutHtml", "#bookingHtml", "#html1"];
let htmlComponent = null;
let categoryItem = null;
let categoryPromise = null;
let pricingCatalog = null;
let pricingPromise = null;
let memberPrefill = null;
let memberPrefillPromise = null;

function resetCaches() {
  categoryItem = null;
  categoryPromise = null;
  pricingCatalog = null;
  pricingPromise = null;
  memberPrefill = null;
  memberPrefillPromise = null;
}

function getHtmlComponent() {
  return resolveHtmlComponent($w, COMPONENT_CANDIDATES);
}

function post(payload) {
  return postMessageSafe(htmlComponent, payload, "Checkout");
}

function readVehicleId() {
  const query = wixLocation.query || {};
  return String(query.vehicle || query.vehicleId || "").trim();
}

function readCategoryCode() {
  const query = wixLocation.query || {};
  return String(query.category || "").trim();
}

async function ensureCategoryItem() {
  if (categoryItem) return categoryItem;
  if (categoryPromise) return categoryPromise;

  const vehicleId = readVehicleId();
  const categoryCode = readCategoryCode();

  categoryPromise = getVehicleCategoryDetails({ vehicleId, categoryCode })
    .then((item) => {
      categoryItem = item || null;
      return categoryItem;
    })
    .catch((err) => {
      console.warn("Checkout category item unavailable", err);
      categoryItem = null;
      return null;
    })
    .finally(() => {
      categoryPromise = null;
    });

  return categoryPromise;
}

async function ensurePricingCatalog() {
  if (pricingCatalog) return pricingCatalog;
  if (pricingPromise) return pricingPromise;

  pricingPromise = getPublicPricingCatalog()
    .then((data) => {
      pricingCatalog = data || null;
      return pricingCatalog;
    })
    .catch((err) => {
      console.warn("Checkout pricing catalog unavailable", err);
      pricingCatalog = null;
      return null;
    })
    .finally(() => {
      pricingPromise = null;
    });

  return pricingPromise;
}

async function ensureMemberPrefill() {
  if (memberPrefill) return memberPrefill;
  if (memberPrefillPromise) return memberPrefillPromise;

  memberPrefillPromise = currentMember.getMember({ fieldsets: ["FULL"] })
    .then((member) => {
      if (!member) {
        memberPrefill = null;
        return null;
      }
      const details = member.contactDetails || {};
      const address = Array.isArray(details.addresses)
        ? details.addresses.find((item) => item && (item.addressLine || item.city || item.postalCode)) || details.addresses[0]
        : null;

      memberPrefill = {
        firstName: details.firstName || "",
        lastName: details.lastName || "",
        email: (details.emails && details.emails[0]) || member.loginEmail || "",
        phone: (details.phones && details.phones[0]) || "",
        address: address?.addressLine || "",
        address2: address?.addressLine2 || "",
        city: address?.city || "",
        country: address?.country || "",
        postalCode: address?.postalCode || ""
      };
      return memberPrefill;
    })
    .catch((err) => {
      console.warn("Checkout member prefill unavailable", err);
      memberPrefill = null;
      return null;
    })
    .finally(() => {
      memberPrefillPromise = null;
    });

  return memberPrefillPromise;
}

function sendContext() {
  post(buildBookingContext(wixLocation));
}

async function sendPricingCatalog() {
  const catalog = await ensurePricingCatalog();
  post({ type: BRIDGE_TYPES.PRICING, catalog: catalog || null });
}

async function sendCategoryItem() {
  const item = await ensureCategoryItem();
  post({ type: "vehicle-category-data", item: item || null });
}

async function sendMemberPrefill() {
  const payload = await ensureMemberPrefill();
  if (!payload) return;
  post({ type: "member-prefill", member: payload, payload });
}

async function handleSubmitBooking(payload) {
  try {
    const result = await createBooking(payload || {});
    post({
      type: "booking-submit-result",
      success: !!result?.success,
      bookingNumber: result?.bookingNumber || "",
      id: result?._id || result?.id || "",
      message: result?.message || ""
    });
  } catch (err) {
    post({
      type: "booking-submit-result",
      success: false,
      message: err?.message || String(err)
    });
  }
}

function go(path) {
  if (!path) return;
  try { wixLocation.to(String(path)); } catch (err) { console.error("checkout navigation failed", err); }
}

function handleMessage(event) {
  const data = normalizeBridgeMessage(event && event.data);
  if (!data) return;
  if (data.type === BRIDGE_TYPES.WIX_NAV && data.path) {
    go(data.path);
    return;
  }
  if (data.type === BRIDGE_TYPES.REQUEST_CONTEXT) {
    sendContext();
    return;
  }
  if (data.type === BRIDGE_TYPES.REQUEST_PRICING) {
    sendPricingCatalog();
    return;
  }
  if (data.type === "request-vehicle-category-data") {
    sendCategoryItem();
    return;
  }
  if (data.type === "request-member-prefill") {
    sendMemberPrefill();
    return;
  }
  if (data.type === "submit-booking") {
    handleSubmitBooking(data.payload || data.data || {});
  }
}

async function syncAll() {
  sendContext();
  await Promise.all([
    sendPricingCatalog(),
    sendCategoryItem(),
    sendMemberPrefill()
  ]);
}

$w.onReady(async function () {
  htmlComponent = getHtmlComponent();
  if (!htmlComponent) {
    console.error("Checkout HTML component not found");
    return;
  }

  try { htmlComponent.onMessage(handleMessage); } catch (e) { console.error("Bind checkout html onMessage failed", e); }
  await Promise.all([ensurePricingCatalog(), ensureCategoryItem(), ensureMemberPrefill()]);

  const resend = () => {
    [80, 260, 700, 1400, 2400].forEach((delay) => {
      setTimeout(() => { syncAll(); }, delay);
    });
  };

  resend();
  try {
    wixLocation.onChange(() => {
      resetCaches();
      resend();
    });
  } catch (_e) {}

  if (typeof window !== "undefined") {
    window.addEventListener("message", (event) => {
      const data = normalizeBridgeMessage(event && event.data);
      if (!data) return;
      if (data.type === BRIDGE_TYPES.WIX_NAV && data.path) go(data.path);
    });
  }
});
