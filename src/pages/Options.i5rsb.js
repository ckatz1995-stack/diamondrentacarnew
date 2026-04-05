import wixLocation from "wix-location";
import { getPublicPricingCatalog } from "backend/pricingCatalog.jsw";
import { getVehicleCategoryDetails, getFleetModelsPreview } from "backend/bookingEngine";

const COMPONENT_CANDIDATES = ["#bpage3", "#optionsHtml", "#html1"];
let htmlComponent = null;
let categoryItem = null;
let fleetModels = null;
let categoryPromise = null;
let fleetPromise = null;
let pricingCatalog = null;
let pricingPromise = null;

function resetCaches() {
  categoryItem = null;
  fleetModels = null;
  categoryPromise = null;
  fleetPromise = null;
  pricingCatalog = null;
  pricingPromise = null;
}

function normalizeMessage(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  return raw;
}

function getHtmlComponent() {
  for (const selector of COMPONENT_CANDIDATES) {
    try {
      const comp = $w(selector);
      if (comp) return comp;
    } catch (err) {}
  }
  try {
    const selection = $w("HtmlComponent");
    if (selection && typeof selection.forEach === "function") {
      const items = [];
      selection.forEach((component) => items.push(component));
      if (items.length) return items[0];
    }
  } catch (err) {}
  return null;
}

function buildContext() {
  return {
    type: "booking-context",
    query: wixLocation.query || {},
    url: wixLocation.url,
    path: wixLocation.path || []
  };
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
      console.error("Options postMessage failed", innerErr || err);
      return false;
    }
  }
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
      console.error("Options category load failed", err);
      categoryItem = null;
      return null;
    })
    .finally(() => {
      categoryPromise = null;
    });

  return categoryPromise;
}

async function ensureFleetModels() {
  if (fleetModels) return fleetModels;
  if (fleetPromise) return fleetPromise;

  const vehicleId = readVehicleId();
  const categoryCode = readCategoryCode();

  fleetPromise = getFleetModelsPreview({ vehicleId, categoryCode })
    .then((data) => {
      fleetModels = data || { category: categoryCode, items: [] };
      return fleetModels;
    })
    .catch((err) => {
      console.error("Options fleet models load failed", err);
      fleetModels = { category: categoryCode, items: [] };
      return fleetModels;
    })
    .finally(() => {
      fleetPromise = null;
    });

  return fleetPromise;
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
      console.error("Options pricing catalog load failed", err);
      pricingCatalog = null;
      return null;
    })
    .finally(() => {
      pricingPromise = null;
    });

  return pricingPromise;
}

async function sendPricingCatalog() {
  const catalog = await ensurePricingCatalog();
  post({ type: "pricing-catalog-data", catalog: catalog || null });
}

function sendContext() {
  post(buildContext());
}

async function sendCategoryItem() {
  const item = await ensureCategoryItem();
  post({ type: "vehicle-category-data", item: item || null });
}

async function sendFleetModels() {
  const data = await ensureFleetModels();
  post({ type: "fleet-models-data", ...(data || { category: readCategoryCode(), items: [] }) });
}

async function syncAll() {
  sendContext();
  await Promise.all([sendPricingCatalog(), sendCategoryItem(), sendFleetModels()]);
}

function go(path) {
  if (!path) return;
  try { wixLocation.to(String(path)); } catch (err) { console.error("options navigation failed", err); }
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
    return;
  }
  if (data.type === "request-vehicle-category-data") {
    sendCategoryItem();
    return;
  }
  if (data.type === "request-fleet-models-data") {
    sendFleetModels();
  }
}

$w.onReady(async function () {
  htmlComponent = getHtmlComponent();
  if (!htmlComponent) {
    console.error("Options HTML component not found");
    return;
  }

  try { htmlComponent.onMessage(handleMessage); } catch (e) { console.error("Bind options html onMessage failed", e); }
  await Promise.all([ensurePricingCatalog(), ensureCategoryItem(), ensureFleetModels()]);

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
  } catch (e) {}

  if (typeof window !== "undefined") {
    window.addEventListener("message", (event) => {
      const data = normalizeMessage(event && event.data);
      if (!data) return;
      if (data.type === "wix-booking-nav" && data.path) go(data.path);
      if (data.type === "request-booking-context") sendContext();
      if (data.type === "request-pricing-catalog-data") sendPricingCatalog();
      if (data.type === "request-vehicle-category-data") sendCategoryItem();
      if (data.type === "request-fleet-models-data") sendFleetModels();
    });
  }
});
