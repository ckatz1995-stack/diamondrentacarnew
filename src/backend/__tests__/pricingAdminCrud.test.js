import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import * as pricingAdmin from '../pricingAdmin.jsw';

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';

function staffSeed(roleOverrides = {}) {
  const passwordSalt = randomHex(16);
  return {
    StaffRoles: [{
      _id: 'role-admin', key: 'admin', label: 'Administrator', active: true, sortOrder: 1, ...roleOverrides,
    }],
    StaffUsers: [{
      _id: 'user-1', email: EMAIL, fullName: 'Admin User', roleKey: roleOverrides.key || 'admin', active: true,
    }],
    StaffCredentials: [{
      _id: 'cred-1',
      email: EMAIL,
      passwordSalt,
      passwordHash: derivePasswordHash(PASSWORD, passwordSalt),
      active: true,
    }],
    StaffSessions: [],
    StaffAuditLog: [],
  };
}

let fake;
function install(seed = staffSeed()) {
  fake = createFakeWixData(seed).install(wixData);
  return fake;
}

async function adminToken() {
  const { sessionToken } = await loginStaff({ email: EMAIL, password: PASSWORD });
  return sessionToken;
}

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

// Every export that changes pricing data. Enumerated deliberately: if someone adds
// a new mutating endpoint and forgets the auth gate, the coverage test below is
// the thing that should catch it.
const MUTATING_EXPORTS = [
  ['saveBusinessSettings', { payload: { companyName: 'X' } }],
  ['upsertInsurancePlan', { payload: { key: 'cdw', label: 'CDW', pricePerDay: 10 } }],
  ['upsertExtraService', { payload: { key: 'gps', label: 'GPS', price: 5 } }],
  ['upsertFeeRule', { payload: { key: 'night', label: 'Night', amount: 15 } }],
  ['upsertVehicleCategory', { payload: { categoryCode: 'A', title: 'Small' } }],
  ['upsertFleetVehicle', { payload: { plate: 'ABC-1234', category: 'A' } }],
  ['upsertPricingSeason', { payload: { key: 'summer', label: 'Summer' } }],
  ['upsertCategoryRateRule', { payload: { categoryCode: 'A', pricePerDay: 40 } }],
  ['upsertPickupLocation', { payload: { key: 'airport', label: 'Airport' } }],
  ['deletePricingItem', { collectionName: 'InsurancePlans', itemId: 'x' }],
  ['deleteVehicleCategory', { itemId: 'x' }],
  ['deleteFleetVehicle', { itemId: 'x' }],
  ['deletePricingSeason', { itemId: 'x' }],
  ['deleteCategoryRateRule', { itemId: 'x' }],
  ['deletePickupLocation', { itemId: 'x' }],
  ['seedPricingDefaults', {}],
  ['resetPricingDefaults', {}],
];

const READ_EXPORTS = [
  ['getPricingAdminSnapshot', {}],
  ['exportPricingCatalogSnapshot', {}],
  ['getStaffPricingCatalog', {}],
];

describe('auth gating', () => {
  test.each(MUTATING_EXPORTS)('%s refuses a missing token', async (name, args) => {
    install();
    await expect(pricingAdmin[name]({ ...args })).rejects.toThrow('AUTH_REQUIRED');
  });

  test.each(MUTATING_EXPORTS)('%s refuses a bogus token', async (name, args) => {
    install();
    await expect(pricingAdmin[name]({ authToken: 'made-up-token', ...args })).rejects.toThrow('AUTH_REQUIRED');
  });

  test.each(READ_EXPORTS)('%s refuses a missing token', async (name, args) => {
    install();
    await expect(pricingAdmin[name]({ ...args })).rejects.toThrow('AUTH_REQUIRED');
  });

  test('every mutating export writes nothing when the caller is unauthenticated', async () => {
    install();
    for (const [name, args] of MUTATING_EXPORTS) {
      await pricingAdmin[name]({ authToken: 'made-up-token', ...args }).catch(() => {});
    }
    expect(fake.calls.insert.filter((c) => c.collection !== 'StaffRoles')).toHaveLength(0);
    expect(fake.calls.update).toHaveLength(0);
    expect(fake.calls.remove).toHaveLength(0);
  });

  test('a signed-out token stops working', async () => {
    install();
    const token = await adminToken();
    // Proves the gate consults live session state rather than merely parsing the token.
    const [session] = fake.rows('StaffSessions');
    await wixData.update('StaffSessions', { ...session, active: false });

    await expect(pricingAdmin.upsertInsurancePlan({ authToken: token, payload: { key: 'cdw', label: 'CDW', pricePerDay: 1 } }))
      .rejects.toThrow('AUTH_REQUIRED');
  });

  test('a non-admin role without pricing edit permission is denied', async () => {
    install(staffSeed({ _id: 'role-viewer', key: 'viewer', label: 'Viewer' }));
    const token = await adminToken();
    await expect(pricingAdmin.upsertInsurancePlan({ authToken: token, payload: { key: 'cdw', label: 'CDW', pricePerDay: 1 } }))
      .rejects.toThrow('ACCESS_DENIED');
  });
});

describe('upsert validation', () => {
  test('rejects a negative insurance price', async () => {
    install();
    const token = await adminToken();
    await expect(pricingAdmin.upsertInsurancePlan({ authToken: token, payload: { key: 'cdw', label: 'CDW', pricePerDay: -1 } }))
      .rejects.toThrow(/Invalid insurance/i);
  });

  test('rejects a negative extra service price', async () => {
    install();
    const token = await adminToken();
    await expect(pricingAdmin.upsertExtraService({ authToken: token, payload: { key: 'gps', label: 'GPS', price: -5 } }))
      .rejects.toThrow(/Invalid extra/i);
  });

  test('accepts a zero price', async () => {
    install();
    const token = await adminToken();
    const saved = await pricingAdmin.upsertInsurancePlan({ authToken: token, payload: { key: 'cdw', label: 'CDW', pricePerDay: 0 } });
    expect(saved.pricePerDay).toBe(0);
  });
});

describe('upsert behaviour', () => {
  test('creates a plan and normalises its key', async () => {
    install();
    const token = await adminToken();
    const saved = await pricingAdmin.upsertInsurancePlan({
      authToken: token,
      payload: { label: 'Super CDW Plus', pricePerDay: 12 },
    });
    expect(saved.key).toBe('super_cdw_plus');
    expect(saved.label).toBe('Super CDW Plus');
  });

  test('updates in place rather than duplicating when the key repeats', async () => {
    install();
    const token = await adminToken();
    await pricingAdmin.upsertInsurancePlan({ authToken: token, payload: { key: 'cdw', label: 'CDW', pricePerDay: 10 } });
    await pricingAdmin.upsertInsurancePlan({ authToken: token, payload: { key: 'cdw', label: 'CDW', pricePerDay: 14 } });

    const rows = fake.rows('InsurancePlans').filter((r) => r.key === 'cdw');
    expect(rows).toHaveLength(1);
    expect(rows[0].pricePerDay).toBe(14);
  });

  test('preserves fields not present in the update payload', async () => {
    // Guards the merge that the comma-operator bug in upsertByKey used to break.
    install();
    const token = await adminToken();
    await pricingAdmin.upsertInsurancePlan({
      authToken: token,
      payload: { key: 'cdw', label: 'CDW', description: 'Basic cover', pricePerDay: 10 },
    });
    await pricingAdmin.upsertInsurancePlan({
      authToken: token,
      payload: { key: 'cdw', label: 'CDW', pricePerDay: 14 },
    });

    const [row] = fake.rows('InsurancePlans').filter((r) => r.key === 'cdw');
    expect(row.pricePerDay).toBe(14);
    expect(row._id).toBeTruthy();
  });
});

describe('audit trail', () => {
  test('records an audit entry when pricing changes', async () => {
    // Regression test: the audit insert passed no options because
    // { suppressAuth: true } had been misplaced into a text() call, so writes
    // could fail on permissions and the surrounding catch swallowed it — losing
    // the record of who changed prices.
    install();
    const token = await adminToken();
    const before = fake.rows('StaffAuditLog').length;

    await pricingAdmin.upsertInsurancePlan({ authToken: token, payload: { key: 'cdw', label: 'CDW', pricePerDay: 10 } });

    const entries = fake.rows('StaffAuditLog');
    expect(entries.length).toBeGreaterThan(before);
    expect(entries.some((e) => String(e.action || '').startsWith('pricing.'))).toBe(true);
  });

  test('passes suppressAuth as the options argument on the audit insert', async () => {
    // The precise shape matters: the bug put { suppressAuth: true } inside a
    // text() call, so the insert received no options at all. Asserting on the
    // item alone would not have caught that — the options argument is the thing
    // that was missing.
    install();
    const token = await adminToken();
    await pricingAdmin.upsertInsurancePlan({ authToken: token, payload: { key: 'cdw', label: 'CDW', pricePerDay: 10 } });

    // Must target the pricing entry specifically: loginStaff also writes to
    // StaffAuditLog, and its insert passes options correctly, so asserting on the
    // first audit insert would check the wrong row and pass regardless.
    const pricingAudit = fake.calls.insert.filter(
      (c) => c.collection === 'StaffAuditLog' && String(c.item?.action || '').startsWith('pricing.'),
    );
    expect(pricingAudit.length).toBeGreaterThan(0);
    expect(pricingAudit[0].options).toEqual({ suppressAuth: true });
    expect(pricingAudit[0].item).not.toHaveProperty('suppressAuth');
  });

  test('names the acting staff member in the audit entry', async () => {
    install();
    const token = await adminToken();
    await pricingAdmin.upsertInsurancePlan({ authToken: token, payload: { key: 'cdw', label: 'CDW', pricePerDay: 10 } });

    const entry = fake.rows('StaffAuditLog').find((e) => String(e.action || '').startsWith('pricing.'));
    expect(entry.actorEmail).toBe(EMAIL);
  });
});
