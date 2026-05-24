import wixLocation from "wix-location";
import { currentMember } from "wix-members-frontend";
import { getVehicleCategoryDetails, createBooking } from "backend/bookingEngine";
import { BRIDGE_TYPES, buildBookingContext, isTrustedBridgeOrigin, normalizeBridgeMessage, postMessageSafe } from "public/bridgeUtils";

let categoryItem = null;
let categoryPromise = null;

function getHtmlComponents() {
  try {
    const selection = $w("HtmlComponent");
    if (!selection || typeof selection.forEach !== "function") return [];
    const items = [];
    selection.forEach((component) => items.push(component));
    return items;
  } catch (_err) {
    return [];
  }
}

function post(component, payload) {
  return postMessageSafe(component, payload, "Booking");
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
      console.warn("Booking category item unavailable", err);
      categoryItem = null;
      return null;
    })
    .finally(() => {
      categoryPromise = null;
    });

  return categoryPromise;
}

async function getMemberPrefill() {
  try {
    const member = await currentMember.getMember({ fieldsets: ["FULL"] });
    if (!member) return null;
    const details = member.contactDetails || {};
    const address = Array.isArray(details.addresses)
      ? details.addresses.find((item) => item && (item.addressLine || item.city || item.postalCode)) || details.addresses[0]
      : null;

    return {
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
  } catch (_err) {
    console.warn("Member prefill unavailable", _err);
    return null;
  }
}

async function sendPrefill(component) {
  const payload = await getMemberPrefill();
  if (!payload) return;
  post(component, { type: "member-prefill", member: payload, payload });
}

async function sendCategoryItem(component) {
  const item = await ensureCategoryItem();
  post(component, { type: "vehicle-category-data", item: item || null });
}

function sendContext(component) {
  post(component, buildBookingContext(wixLocation));
}

async function handleSubmitBooking(component, payload) {
  try {
    const result = await createBooking(payload || {});
    post(component, {
      type: "booking-submit-result",
      success: !!result?.success,
      bookingNumber: result?.bookingNumber || "",
      id: result?._id || result?.id || "",
      message: result?.message || ""
    });
  } catch (_err) {
    post(component, {
      type: "booking-submit-result",
      success: false,
      message: _err?.message || String(_err)
    });
  }
}

function bindComponent(component) {
  try {
    component.onMessage(async (event) => {
      const origin = String(event?.origin || '').trim();
      if (origin && !isTrustedBridgeOrigin(origin, wixLocation.url)) return;
      const data = normalizeBridgeMessage(event && event.data);
      if (!data) return;
      if (data.type === "request-member-prefill") { await sendPrefill(component); return; }
      if (data.type === BRIDGE_TYPES.REQUEST_CONTEXT) { sendContext(component); return; }
      if (data.type === "request-vehicle-category-data") { await sendCategoryItem(component); return; }
      if (data.type === "submit-booking") { await handleSubmitBooking(component, data.payload || data.data || {}); return; }
      if (data.type === BRIDGE_TYPES.WIX_NAV && data.path) {
        try { wixLocation.to(data.path); } catch (navErr) { console.warn("Booking navigation failed", navErr); }
      }
    });
  } catch (_err) {
    console.warn("Failed to bind HTML component message", _err);
  }
}

async function syncAll(components) {
  components.forEach((component) => sendContext(component));
  await Promise.all(components.map((component) => sendCategoryItem(component)));
  await Promise.all(components.map((component) => sendPrefill(component)));
}

$w.onReady(async function () {
  const components = getHtmlComponents();
  if (!components.length) return;

  components.forEach(bindComponent);
  await ensureCategoryItem();

  const resend = () => {
    [100, 350, 900, 1800].forEach((delay) => {
      setTimeout(() => { syncAll(components); }, delay);
    });
  };

  resend();

  if (typeof window !== "undefined") {
    window.addEventListener("message", (event) => {
      if (!isTrustedBridgeOrigin(event?.origin, wixLocation.url)) return;
      const data = normalizeBridgeMessage(event && event.data);
      if (!data) return;
      if (data.type === BRIDGE_TYPES.WIX_NAV && data.path) {
        try { wixLocation.to(data.path); } catch (navErr) { console.warn("Booking navigation failed", navErr); }
      }
    });
  }
});
