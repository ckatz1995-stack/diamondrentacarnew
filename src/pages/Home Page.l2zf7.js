import wixLocation from "wix-location";
import { getPublicPricingCatalog } from "backend/pricingCatalog.jsw";
import { getVehicleCategoriesCatalog } from "backend/bookingEngine";
import { BRIDGE_TYPES, buildBookingContext, isTrustedBridgeOrigin, normalizeBridgeMessage, postMessageSafe, resolveHtmlComponent } from "public/bridgeUtils";
const COMP = "#bpage1";

let pricingCatalog = null;
let vehicleCategories = [];
let pricingPromise = null;
let categoriesPromise = null;
let bridgeReadyAck = false;

function go(path) {
  if (!path) return;
  try { wixLocation.to(String(path)); } catch (err) { console.error("Home navigation failed", err); }
}

function getComponent(){
  return resolveHtmlComponent($w, [COMP]);
}

function post(payload){
  return postMessageSafe(getComponent(), payload, "Home Page");
}

async function ensurePricingCatalog(){
  if (pricingCatalog) return pricingCatalog;
  if (pricingPromise) return pricingPromise;
  pricingPromise = getPublicPricingCatalog()
    .then((data)=>{ pricingCatalog = data || null; return pricingCatalog; })
    .catch((err)=>{ console.warn("Home pricing catalog unavailable", err); pricingCatalog = null; return null; })
    .finally(()=>{ pricingPromise = null; });
  return pricingPromise;
}

async function ensureVehicleCategories(){
  if (vehicleCategories.length) return vehicleCategories;
  if (categoriesPromise) return categoriesPromise;
  categoriesPromise = getVehicleCategoriesCatalog()
    .then((items)=>{ vehicleCategories = Array.isArray(items) ? items : []; return vehicleCategories; })
    .catch((err)=>{ console.warn("Home categories unavailable", err); vehicleCategories = []; return []; })
    .finally(()=>{ categoriesPromise = null; });
  return categoriesPromise;
}

async function syncData(){
  const [catalog, categories] = await Promise.all([ensurePricingCatalog(), ensureVehicleCategories()]);
  post({ type: BRIDGE_TYPES.PRICING, catalog: catalog || null });
  post({ type: "pickup-locations-data", items: Array.isArray(catalog?.pickupLocations) ? catalog.pickupLocations : [] });
  post({ type: "vehicle-categories-data", items: categories || [] });
  post(buildBookingContext(wixLocation));
}

function handleMessage(event) {
  const origin = String(event?.origin || '').trim();
  if (origin && !isTrustedBridgeOrigin(origin, wixLocation.url)) return;
  const data = normalizeBridgeMessage(event && event.data);
  if (!data) return;
  if (data.type === "home-ready" || data.type === "bridge-ready") {
    bridgeReadyAck = true;
    syncData();
    return;
  }
  if (data.type === BRIDGE_TYPES.WIX_NAV && data.path) { go(data.path); return; }
  if (data.type === BRIDGE_TYPES.REQUEST_CONTEXT) {
    post(buildBookingContext(wixLocation));
    return;
  }
  if (data.type === BRIDGE_TYPES.REQUEST_PRICING) { ensurePricingCatalog().then((catalog)=>post({ type: BRIDGE_TYPES.PRICING, catalog: catalog || null })); return; }
  if (data.type === "request-pickup-locations-data") { ensurePricingCatalog().then((catalog)=>post({ type: "pickup-locations-data", items: Array.isArray(catalog?.pickupLocations) ? catalog.pickupLocations : [] })); return; }
  if (data.type === "request-vehicle-categories-data") { ensureVehicleCategories().then((items)=>post({ type: "vehicle-categories-data", items: items || [] })); }
}

$w.onReady(async function () {
  const comp = getComponent();
  if (comp) {
    try { comp.onMessage(handleMessage); } catch (e) { console.error("Bind home html onMessage failed", e); }
  }
  await syncData();
  setTimeout(() => {
    if (!bridgeReadyAck) syncData();
  }, 1200);
  if (typeof window !== "undefined") {
    window.addEventListener("message", (event) => {
      if (!isTrustedBridgeOrigin(event?.origin, wixLocation.url)) return;
      const data = normalizeBridgeMessage(event && event.data);
      if (!data) return;
      if (data.type === BRIDGE_TYPES.WIX_NAV && data.path) go(data.path);
      if (data.type === BRIDGE_TYPES.REQUEST_CONTEXT) post(buildBookingContext(wixLocation));
      if (data.type === BRIDGE_TYPES.REQUEST_PRICING) ensurePricingCatalog().then((catalog)=>post({ type: BRIDGE_TYPES.PRICING, catalog: catalog || null }));
      if (data.type === "request-pickup-locations-data") ensurePricingCatalog().then((catalog)=>post({ type: "pickup-locations-data", items: Array.isArray(catalog?.pickupLocations) ? catalog.pickupLocations : [] }));
      if (data.type === "request-vehicle-categories-data") ensureVehicleCategories().then((items)=>post({ type: "vehicle-categories-data", items: items || [] }));
    });
  }
});
