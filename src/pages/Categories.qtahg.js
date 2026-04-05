import wixLocation from "wix-location";
import { getPublicPricingCatalog } from "backend/pricingCatalog.jsw";
import { getFleetModelsPreview, getVehicleCategoriesCatalog } from "backend/bookingEngine";
import { BRIDGE_TYPES, buildBookingContext, normalizeBridgeMessage, postMessageSafe, resolveHtmlComponent } from "public/bridgeUtils";

const COMPONENT_CANDIDATES = ["#bpage2", "#categoriesHtml", "#vehiclesHtml"];
let htmlComponent = null;
let vehicleItems = [];
let vehicleError = "";
let vehiclesPromise = null;
let pricingCatalog = null;
let pricingPromise = null;
let vehiclesMeta = { displayMode: "categories", modelsSource: "fleet" };

function resetCaches() {
  vehicleItems = [];
  vehicleError = '';
  vehiclesPromise = null;
  pricingCatalog = null;
  pricingPromise = null;
  vehiclesMeta = { displayMode: "categories", modelsSource: "fleet" };
}

function getHtmlComponent() {
  return resolveHtmlComponent($w, COMPONENT_CANDIDATES);
}

function post(payload) {
  return postMessageSafe(htmlComponent, payload, "Categories");
}

function readVehiclesPageMode() {
  const mode = String(pricingCatalog?.businessSettings?.vehiclesPageDisplayMode || '').trim().toLowerCase();
  return mode === 'models' ? 'models' : 'categories';
}

function readVehiclesPageModelsSource() {
  const source = String(pricingCatalog?.businessSettings?.vehiclesPageModelsSource || '').trim().toLowerCase();
  return source === 'vehicles' ? 'vehicles' : 'fleet';
}

function mapCategoryRowToModelCard(item = {}) {
  const modelName = String(item.name || item.title || item.displayName || item.displayTitle || item.categoryCode || item.category || 'Μοντέλο').trim();
  return {
    ...item,
    itemType: 'model',
    source: 'vehicles',
    model: modelName,
    title: modelName,
    name: modelName,
    displayName: modelName,
    displayTitle: modelName,
    categoryLabel: item.displayTitle || item.displayName || item.name || item.title || item.categoryCode || item.category || ''
  };
}

async function ensureVehicles() {
  if (vehicleItems.length) return vehicleItems;
  if (vehiclesPromise) return vehiclesPromise;

  vehiclesPromise = (async () => {
    await ensurePricingCatalog();
    const displayMode = readVehiclesPageMode();
    const modelsSource = readVehiclesPageModelsSource();
    vehiclesMeta = { displayMode, modelsSource };

    if (displayMode === 'models') {
      if (modelsSource === 'vehicles') {
        const categoryRows = await getVehicleCategoriesCatalog();
        vehicleItems = (Array.isArray(categoryRows) ? categoryRows : []).map(mapCategoryRowToModelCard);
      } else {
        const preview = await getFleetModelsPreview({});
        vehicleItems = Array.isArray(preview?.items) ? preview.items : [];
      }
    } else {
      vehicleItems = await getVehicleCategoriesCatalog();
      if (!Array.isArray(vehicleItems)) vehicleItems = [];
    }

    vehicleError = '';
    return vehicleItems;
  })()
    .catch((err) => {
      console.error('Load vehicles page catalog failed', err);
      vehicleItems = [];
      vehicleError = err?.message || 'Vehicles page catalog load failed';
      return vehicleItems;
    })
    .finally(() => {
      vehiclesPromise = null;
    });

  return vehiclesPromise;
}

async function sendVehicles() {
  await ensureVehicles();
  if (vehicleError) {
    post({ type: "vehicles-data-error", message: vehicleError, items: [] });
    return;
  }
  post({ type: "vehicles-data", items: vehicleItems, meta: vehiclesMeta });
}


async function ensurePricingCatalog() {
  if (pricingCatalog) return pricingCatalog;
  if (pricingPromise) return pricingPromise;

  pricingPromise = getPublicPricingCatalog()
    .then((data) => {
      pricingCatalog = data || null;
      vehiclesMeta = { displayMode: readVehiclesPageMode(), modelsSource: readVehiclesPageModelsSource() };
      return pricingCatalog;
    })
    .catch((err) => {
      console.error("Load pricing catalog failed", err);
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
  post({ type: BRIDGE_TYPES.PRICING, catalog: catalog || null });
}

function sendContext() {
  post(buildBookingContext(wixLocation));
}

async function syncAll() {
  await sendPricingCatalog();
  sendContext();
  await sendVehicles();
}

function go(path) {
  if (!path) return;
  try { wixLocation.to(String(path)); } catch (err) { console.error("categories navigation failed", err); }
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
  if (data.type === "request-vehicles-data" || data.type === "categories-ready") {
    sendVehicles();
  }
}

$w.onReady(async function () {
  htmlComponent = getHtmlComponent();
  if (!htmlComponent) {
    console.error("Categories HTML component not found");
    return;
  }

  try { htmlComponent.onMessage(handleMessage); } catch (e) { console.error("Bind categories html onMessage failed", e); }

  await ensureVehicles();

  const resend = () => {
    [80, 260, 700, 1400, 2400, 4200, 6200].forEach((delay) => {
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
      const data = normalizeBridgeMessage(event && event.data);
      if (!data) return;
      if (data.type === BRIDGE_TYPES.WIX_NAV && data.path) go(data.path);
      if (data.type === BRIDGE_TYPES.REQUEST_CONTEXT) sendContext();
      if (data.type === "request-vehicles-data" || data.type === "categories-ready") sendVehicles();
    });
  }
});
