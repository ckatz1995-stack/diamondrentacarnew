import wixLocation from "wix-location";
import { getPublicPricingCatalog } from "backend/pricingCatalog.jsw";
const COMP = "#html1";

function normalizeMessage(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch (_e) { return null; }
  }
  return raw;
}

function post(payload) {
  try { $w(COMP).postMessage(payload); } catch (e) { console.error('postMessage to success html failed', e); }
}

function sendContext() {
  const payload = {
    type: "booking-context",
    query: wixLocation.query || {},
    url: wixLocation.url,
    path: wixLocation.path || []
  };
  post(payload);
}

async function sendPricingCatalog() {
  try {
    const catalog = await getPublicPricingCatalog();
    post({ type: 'pricing-catalog-data', catalog: catalog || null });
  } catch (err) {
    console.warn('Success pricing catalog unavailable', err);
  }
}

function go(path) {
  if (!path) return;
  try { wixLocation.to(String(path)); } catch (err) { console.error("success navigation failed", err); }
}

function handleMessage(event) {
  const data = normalizeMessage(event && event.data);
  if (data && data.type === "request-booking-context") { sendContext(); return; }
  if (data && data.type === 'request-pricing-catalog-data') { sendPricingCatalog(); return; }
  if (data && data.type === "wix-booking-nav" && data.path) go(data.path);
}

$w.onReady(function () {
  try { $w(COMP).onMessage(handleMessage); } catch (e) { console.error("Bind success html onMessage failed", e); }
  const resend = () => { setTimeout(sendContext, 100); setTimeout(sendContext, 500); setTimeout(sendContext, 1200); setTimeout(sendPricingCatalog, 180); setTimeout(sendPricingCatalog, 700); };
  resend();
  try { wixLocation.onChange(() => resend()); } catch (_e) {}
  if (typeof window !== "undefined") {
    window.addEventListener("message", (event) => {
      const data = normalizeMessage(event && event.data);
      if (data && data.type === "wix-booking-nav" && data.path) go(data.path);
    });
  }
});
