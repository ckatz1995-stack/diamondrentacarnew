import wixLocation from "wix-location";
import { getPublicPricingCatalog } from "backend/pricingCatalog.jsw";

const HTML_COMPONENT_ID = "#termsHtml";
let htmlComponent = null;
let pricingCatalog = null;
let pricingPromise = null;

function normalizeMessage(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch (err) { return null; }
  }
  return raw;
}

function isHtmlBridgeComponent(comp) {
  return !!(comp && typeof comp.onMessage === "function" && typeof comp.postMessage === "function");
}

function getHtmlComponent() {
  try {
    const comp = $w(HTML_COMPONENT_ID);
    if (isHtmlBridgeComponent(comp)) return comp;
  } catch (err) {}
  return null;
}

function post(payload) {
  if (!htmlComponent || !payload) return false;
  try {
    htmlComponent.postMessage(payload);
    return true;
  } catch (err) {
    try {
      htmlComponent.postMessage(JSON.stringify(payload));
      return true;
    } catch (innerErr) {
      console.error("Rental terms postMessage failed", innerErr || err);
      return false;
    }
  }
}

function buildContext() {
  return {
    type: "booking-context",
    query: wixLocation.query || {},
    url: wixLocation.url,
    path: wixLocation.path || []
  };
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
  post(buildContext());
}

async function sendPricingCatalog() {
  const catalog = await ensurePricingCatalog();
  post({ type: "pricing-catalog-data", catalog: catalog || null });
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
  const data = normalizeMessage(event && event.data);
  if (!data) return;
  if (data.type === "wix-booking-nav" && data.path) {
    go(data.path);
    return;
  }
  if (data.type === "request-booking-context") {
    sendContext();
    return;
  }
  if (data.type === "request-pricing-catalog-data") {
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
  try { wixLocation.onChange(() => resend()); } catch (err) {}

  if (typeof window !== "undefined") {
    window.addEventListener("message", (event) => {
      const data = normalizeMessage(event && event.data);
      if (!data) return;
      if (data.type === "wix-booking-nav" && data.path) go(data.path);
      if (data.type === "request-booking-context") sendContext();
      if (data.type === "request-pricing-catalog-data") sendPricingCatalog();
    });
  }
});
