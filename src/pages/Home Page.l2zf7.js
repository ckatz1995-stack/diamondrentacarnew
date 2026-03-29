import wixLocation from "wix-location";
import { getPublicPricingCatalog } from "backend/pricingCatalog.jsw";
import { getVehicleCategoriesCatalog } from "backend/bookingEngine";
const COMP = "#bpage1";

let pricingCatalog = null;
let vehicleCategories = [];
let pricingPromise = null;
let categoriesPromise = null;

function normalizeMessage(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  return raw;
}

function go(path) {
  if (!path) return;
  try { wixLocation.to(String(path)); } catch (err) { console.error("Home navigation failed", err); }
}

function getComponent(){
  try { return $w(COMP); } catch (e) { return null; }
}

function post(payload){
  const comp = getComponent();
  if (!comp || !payload) return;
  try { comp.postMessage(payload); }
  catch (e) {
    try { comp.postMessage(JSON.stringify(payload)); } catch (_) {}
  }
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
  post({ type: "pricing-catalog-data", catalog: catalog || null });
  post({ type: "pickup-locations-data", items: Array.isArray(catalog?.pickupLocations) ? catalog.pickupLocations : [] });
  post({ type: "vehicle-categories-data", items: categories || [] });
  post({ type: "booking-context", query: wixLocation.query || {}, url: wixLocation.url, path: wixLocation.path || [] });
}

function handleMessage(event) {
  const data = normalizeMessage(event && event.data);
  if (!data) return;
  if (data.type === "wix-booking-nav" && data.path) { go(data.path); return; }
  if (data.type === "request-booking-context") {
    post({ type: "booking-context", query: wixLocation.query || {}, url: wixLocation.url, path: wixLocation.path || [] });
    return;
  }
  if (data.type === "request-pricing-catalog-data") { ensurePricingCatalog().then((catalog)=>post({ type: "pricing-catalog-data", catalog: catalog || null })); return; }
  if (data.type === "request-pickup-locations-data") { ensurePricingCatalog().then((catalog)=>post({ type: "pickup-locations-data", items: Array.isArray(catalog?.pickupLocations) ? catalog.pickupLocations : [] })); return; }
  if (data.type === "request-vehicle-categories-data") { ensureVehicleCategories().then((items)=>post({ type: "vehicle-categories-data", items: items || [] })); }
}

$w.onReady(async function () {
  const comp = getComponent();
  if (comp) {
    try { comp.onMessage(handleMessage); } catch (e) { console.error("Bind home html onMessage failed", e); }
  }
  await syncData();
  [120, 400, 1000, 2200].forEach((delay) => setTimeout(() => { syncData(); }, delay));
  if (typeof window !== "undefined") {
    window.addEventListener("message", (event) => {
      const data = normalizeMessage(event && event.data);
      if (!data) return;
      if (data.type === "wix-booking-nav" && data.path) go(data.path);
      if (data.type === "request-booking-context") post({ type: "booking-context", query: wixLocation.query || {}, url: wixLocation.url, path: wixLocation.path || [] });
      if (data.type === "request-pricing-catalog-data") ensurePricingCatalog().then((catalog)=>post({ type: "pricing-catalog-data", catalog: catalog || null }));
      if (data.type === "request-pickup-locations-data") ensurePricingCatalog().then((catalog)=>post({ type: "pickup-locations-data", items: Array.isArray(catalog?.pickupLocations) ? catalog.pickupLocations : [] }));
      if (data.type === "request-vehicle-categories-data") ensureVehicleCategories().then((items)=>post({ type: "vehicle-categories-data", items: items || [] }));
    });
  }
});
