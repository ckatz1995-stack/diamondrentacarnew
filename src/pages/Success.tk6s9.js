import wixLocation from "wix-location";
import { getPublicPricingCatalog } from "backend/pricingCatalog.jsw";
import { BRIDGE_TYPES, buildBookingContext, isTrustedBridgeOrigin, normalizeBridgeMessage, postMessageSafe, resolveHtmlComponent } from "public/bridgeUtils";

const COMPONENT_CANDIDATES = ["#html1", "#successHtml"];
let htmlComponent = null;
let pricingCatalog = null;
let pricingPromise = null;

function post(payload) {
  return postMessageSafe(htmlComponent, payload, "Success");
}

function sendContext() {
  post(buildBookingContext(wixLocation));
}

async function ensurePricingCatalog() {
  if (pricingCatalog) return pricingCatalog;
  if (pricingPromise) return pricingPromise;
  pricingPromise = getPublicPricingCatalog()
    .then((data) => { pricingCatalog = data || null; return pricingCatalog; })
    .catch((err) => { console.warn("Success pricing catalog unavailable", err); pricingCatalog = null; return null; })
    .finally(() => { pricingPromise = null; });
  return pricingPromise;
}

async function sendPricingCatalog() {
  const catalog = await ensurePricingCatalog();
  post({ type: BRIDGE_TYPES.PRICING, catalog: catalog || null });
}

function go(path) {
  if (!path) return;
  try { wixLocation.to(String(path)); } catch (err) { console.error("Success navigation failed", err); }
}

function handleMessage(event) {
  const origin = String(event?.origin || '').trim();
  if (origin && !isTrustedBridgeOrigin(origin, wixLocation.url)) return;
  const data = normalizeBridgeMessage(event && event.data);
  if (!data) return;
  if (data.type === BRIDGE_TYPES.REQUEST_CONTEXT) { sendContext(); return; }
  if (data.type === BRIDGE_TYPES.REQUEST_PRICING) { sendPricingCatalog(); return; }
  if (data.type === BRIDGE_TYPES.WIX_NAV && data.path) go(data.path);
}

$w.onReady(async function () {
  htmlComponent = resolveHtmlComponent($w, COMPONENT_CANDIDATES);
  if (!htmlComponent) {
    console.error("Success HTML component not found");
    return;
  }

  try { htmlComponent.onMessage(handleMessage); } catch (e) { console.error("Bind success html onMessage failed", e); }

  const resend = () => {
    [100, 300, 800, 1800].forEach((delay) => {
      setTimeout(() => { sendContext(); sendPricingCatalog(); }, delay);
    });
  };

  resend();
  try { wixLocation.onChange(() => resend()); } catch (_e) {}

  if (typeof window !== "undefined") {
    window.addEventListener("message", (event) => {
      if (!isTrustedBridgeOrigin(event?.origin, wixLocation.url)) return;
      const data = normalizeBridgeMessage(event && event.data);
      if (!data) return;
      if (data.type === BRIDGE_TYPES.WIX_NAV && data.path) go(data.path);
    });
  }
});
