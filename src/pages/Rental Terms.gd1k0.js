import wixLocation from "wix-location";
import { getPublicPricingCatalog } from "backend/pricingCatalog.jsw";
import { BRIDGE_TYPES, buildBookingContext, normalizeBridgeMessage, postMessageSafe, resolveHtmlComponent } from "public/bridgeUtils";

const HTML_COMPONENT_ID = "#termsHtml";
let htmlComponent = null;
let pricingCatalog = null;
let pricingPromise = null;

function resetCaches() {
  pricingCatalog = null;
  pricingPromise = null;
}

function getHtmlComponent() {
  return resolveHtmlComponent($w, [HTML_COMPONENT_ID]);
}

function post(payload) {
  return postMessageSafe(htmlComponent, payload, "Rental Terms");
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
      console.warn("Rental terms pricing catalog unavailable", err);
      pricingCatalog = null;
      return null;
    })
    .finally(() => {
      pricingPromise = null;
    });

  return pricingPromise;
}

function sendContext() {
  post(buildBookingContext(wixLocation));
}

async function sendPricingCatalog() {
  const catalog = await ensurePricingCatalog();
  post({ type: BRIDGE_TYPES.PRICING, catalog: catalog || null });
}

async function syncAll() {
  sendContext();
  await sendPricingCatalog();
}

function go(path) {
  if (!path) return;
  try {
    wixLocation.to(String(path));
  } catch (err) {
    console.error("rental-terms navigation failed", err);
  }
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
  }
}

$w.onReady(async function () {
  htmlComponent = getHtmlComponent();
  if (!htmlComponent) {
    console.error(`Rental terms HTML component not found or wrong id. Expected ${HTML_COMPONENT_ID}`);
    return;
  }

  try {
    htmlComponent.onMessage(handleMessage);
  } catch (err) {
    console.error("Bind rental terms html onMessage failed", err);
  }

  await ensurePricingCatalog();

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
  } catch (err) {}

  if (typeof window !== "undefined") {
    window.addEventListener("message", (event) => {
      const data = normalizeBridgeMessage(event && event.data);
      if (!data) return;
      if (data.type === BRIDGE_TYPES.WIX_NAV && data.path) go(data.path);
      if (data.type === BRIDGE_TYPES.REQUEST_CONTEXT) sendContext();
      if (data.type === BRIDGE_TYPES.REQUEST_PRICING) sendPricingCatalog();
    });
  }
});
