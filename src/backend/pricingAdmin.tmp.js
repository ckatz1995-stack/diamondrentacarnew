import wixData from 'wix-data';
import { PRICING_COLLECTIONS, clearPricingCatalogCache, getPricingCatalog } from 'backend/pricingCatalog.jsw';
import { assertStaffPermission } from 'backend/staffAccess.jsw';

function text(value, fallback = '') { const out = String(value ?? '').trim(); return out || fallback; }
function toNumber(value, fallback = 0) { const num = Number(value); return Number.isFinite(num) ? num : fallback; }
function readBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const t = String(value ?? '').trim().toLowerCase();
  if (!t) return fallback;
  return ['1','true','yes','y','on'].includes(t);
}
function slugKey(value) {
  return String(value ?? '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_{2,}/g, '_').toLowerCase();
}

export async function getPricingAdminSnapshot() {
  await assertStaffPermission({ moduleKey: 'pricing', action: 'view' });
  return getPricingCatalog({ scope: 'all', force: true });
}

export async function saveBusinessSettings(payload = {}) {
  await assertStaffPermission({ moduleKey: 'pricing', action: 'edit', special: 'manageBusinessSettings' });
  const existing = await wixData.query(PRICING_COLLECTIONS.businessSettings).limit(1).find({ suppressAuth: true }).catch(() => ({ items: [] }));
  const base = existing.items?.[0] || {};
  const item = {
    ...base,
    title: text(payload.title, 'Business settings'),
    currency: text(payload.currency, 'EUR'),
    vatRate: toNumber(payload.vatRate, 24),
    nightStartHour: toNumber(payload.nightStartHour, 22),
    nightEndHour: toNumber(payload.nightEndHour, 8),
    defaultDeposit: toNumber(payload.defaultDeposit, 300),
    companyPhone: text(payload.companyPhone, '+30 2310 000 000'),
    companyEmail: text(payload.companyEmail, 'info@diamondrentacar.gr'),
    active: readBool(payload.active, true)
  };
  const saved = item._id
    ? await wixData.update(PRICING_COLLECTIONS.businessSettings, item, { suppressAuth: true })
    : await wixData.insert(PRICING_COLLECTIONS.businessSettings, item, { suppressAuth: true });
  clearPricingCatalogCache();
  return saved;
}

function normalizeCatalogItem(payload = {}, kind = 'insurance') {
  const base = {
    _id: payload._id,
    title: text(payload.title || payload.label || payload.key),
    key: slugKey(payload.key || payload.label || payload.title),
    label: text(payload.label || payload.title),
    description: text(payload.description),
    sortOrder: toNumber(payload.sortOrder, 9999),
    active: readBool(payload.active, true),
    publicVisible: readBool(payload.publicVisible, true)
  };
  if (kind === 'insurance') return { ...base, pricePerDay: toNumber(payload.pricePerDay ?? payload.price, 0), billingMode: 'perDay' };
  if (kind === 'extra') return { ...base, price: toNumber(payload.price ?? payload.pricePerDay, 0), billingMode: text(payload.billingMode, 'perDay') === 'perBooking' ? 'perBooking' : 'perDay' };
  return { ...base, ruleType: text(payload.ruleType, 'manual'), audienceGroup: text(payload.audienceGroup), amount: toNumber(payload.amount ?? payload.price, 0), billingMode: text(payload.billingMode, 'perBooking') === 'perDay' ? 'perDay' : 'perBooking' };
}

async function upsert(collectionName, item) {
  const saved = item._id
    ? await wixData.update(collectionName, item, { suppressAuth: true })
    : await wixData.insert(collectionName, item, { suppressAuth: true });
  clearPricingCatalogCache();
  return saved;
}

export async function upsertInsurancePlan(payload = {}) {
  await assertStaffPermission({ moduleKey: 'pricing', action: 'edit' });
  return upsert(PRICING_COLLECTIONS.insurancePlans, normalizeCatalogItem(payload, 'insurance'));
}

export async function upsertExtraService(payload = {}) {
  await assertStaffPermission({ moduleKey: 'pricing', action: 'edit' });
  return upsert(PRICING_COLLECTIONS.extraServices, normalizeCatalogItem(payload, 'extra'));
}

export async function upsertFeeRule(payload = {}) {
  await assertStaffPermission({ moduleKey: 'pricing', action: 'edit' });
  return upsert(PRICING_COLLECTIONS.feeRules, normalizeCatalogItem(payload, 'fee'));
}

export async function deletePricingItem({ collectionName, itemId } = {}) {
  await assertStaffPermission({ moduleKey: 'pricing', action: 'edit' });
  if (!collectionName || !itemId) throw new Error('Missing collectionName or itemId');
  const allowed = new Set(Object.values(PRICING_COLLECTIONS));
  if (!allowed.has(collectionName)) throw new Error('Collection not allowed');
  await wixData.remove(collectionName, itemId, { suppressAuth: true });
  clearPricingCatalogCache();
  return { success: true };
}
