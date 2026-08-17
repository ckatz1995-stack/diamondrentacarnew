import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import { upsertInsurancePlan } from '../pricingAdmin.jsw';
import { clearPricingCatalogCache } from '../pricingCatalog.jsw';

// The upsert-by-key machinery behind every pricing save: it matches an existing
// row by its normalised key, merges the payload over it, and clears out any
// duplicate rows that ended up sharing that key.
//
// Driven through upsertInsurancePlan rather than against the helper directly.
// The helper used to be exported, which put a function that writes to a
// caller-named collection with suppressAuth on the browser-callable surface; it
// is module-internal now, and this is the path a caller actually takes to reach
// it — permission check, normalisation and all.

const STAFF = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';
const COLLECTION = 'InsurancePlans';

function seed(plans = []) {
  const passwordSalt = randomHex(16);
  return {
    StaffRoles: [{ _id: 'r-admin', key: 'admin', label: 'Admin', active: true }],
    StaffUsers: [{ _id: 'u-admin', email: STAFF, fullName: 'Admin', roleKey: 'admin', active: true }],
    StaffCredentials: [{
      _id: 'c-admin', email: STAFF, passwordSalt,
      passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true,
    }],
    StaffSessions: [],
    StaffAuditLog: [],
    // Seeded non-empty so ensurePricingSeeded leaves these collections alone.
    [COLLECTION]: plans,
    BusinessSettings: [{ _id: 'bs-1', currency: 'EUR' }],
    ExtraServices: [{ _id: 'x-1', key: 'gps', label: 'GPS', price: 5 }],
    FeeRules: [{ _id: 'f-1', key: 'night', label: 'Night', amount: 15 }],
  };
}

let fake;
function install(plans) {
  clearPricingCatalogCache();
  fake = createFakeWixData(seed(plans)).install(wixData);
  return fake;
}

async function token() {
  const { sessionToken } = await loginStaff({ email: STAFF, password: PASSWORD });
  return sessionToken;
}

const save = async (payload) => upsertInsurancePlan({ authToken: await token(), payload });

/** Writes to the plans collection only — the session touch and audit rows are noise here. */
const planWrites = (kind) => fake.calls[kind].filter((c) => c.collection === COLLECTION);
const planRow = (key) => fake.rows(COLLECTION).find((r) => r.key === key);

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
  clearPricingCatalogCache();
});

describe('saving over an existing row', () => {
  const existing = () => [{
    _id: 'plan-1', key: 'cdw', label: 'CDW', description: 'Basic cover',
    pricePerDay: 10, billingMode: 'perDay', active: true, sortOrder: 5,
    // A field no normaliser writes — the merge is the only thing that can carry
    // it through. Picking sortOrder here would prove nothing: normalizeCatalogItem
    // sets that on every save, so it is the payload overwriting, not the merge
    // failing.
    legacyImportRef: 'IMPORT-2019-441',
  }];

  test('passes suppressAuth as the options argument, not as a data field', async () => {
    // The bug this file was written for: a comma operator inside a spread once
    // put suppressAuth into the record instead of into the options argument, so
    // the flag was stored as data and the write ran without it.
    install(existing());
    await save({ _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 12 });

    const [write] = planWrites('update');
    expect(write.options).toEqual({ suppressAuth: true });
    expect(write.item).not.toHaveProperty('suppressAuth');
  });

  test('merges the previous record so fields absent from the payload survive', async () => {
    install(existing());
    await save({ _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 12 });
    expect(planRow('cdw').legacyImportRef).toBe('IMPORT-2019-441');
  });

  test('but a field the normaliser always writes is decided by the save', async () => {
    // The other half, and the one that surprises: sortOrder is written on every
    // save whether the caller mentioned it or not, so an omitted sortOrder is
    // reset to its default rather than preserved.
    install(existing());
    await save({ _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 12 });
    expect(planRow('cdw').sortOrder).toBe(9999);
  });

  test('lets the incoming payload win over the previous record', async () => {
    install(existing());
    await save({ _id: 'plan-1', key: 'cdw', label: 'CDW Updated', pricePerDay: 12 });
    expect(planRow('cdw')).toMatchObject({ label: 'CDW Updated', pricePerDay: 12 });
  });

  test('updates rather than inserting a second row', async () => {
    install(existing());
    await save({ _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 12 });

    expect(planWrites('update')).toHaveLength(1);
    expect(planWrites('insert')).toHaveLength(0);
    expect(fake.rows(COLLECTION)).toHaveLength(1);
  });

  test('is audited as an update, carrying what was there before', async () => {
    install(existing());
    await save({ _id: 'plan-1', key: 'cdw', label: 'CDW Updated', pricePerDay: 12 });

    const entry = fake.rows('StaffAuditLog').find((e) => e.action === 'pricing.update');
    expect(entry).toBeDefined();
    expect(entry.oldValue).toContain('Basic cover');
    expect(entry.newValue).toContain('CDW Updated');
  });

  test('adopts the id of an existing row matched by key when no id is supplied', async () => {
    // How a save from a form that never learned the id still lands on the right
    // row instead of creating a twin.
    install(existing());
    await save({ key: 'cdw', label: 'CDW', pricePerDay: 12 });

    expect(fake.rows(COLLECTION)).toHaveLength(1);
    expect(planRow('cdw')._id).toBe('plan-1');
    expect(planWrites('insert')).toHaveLength(0);
  });

  test('removes duplicate rows that share the key but not the surviving id', async () => {
    install([
      ...existing(),
      { _id: 'plan-dupe', key: 'cdw', label: 'CDW (duplicate)', pricePerDay: 99 },
    ]);
    await save({ _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 12 });

    const remaining = fake.rows(COLLECTION);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]._id).toBe('plan-1');
    expect(planWrites('remove').map((c) => c.id)).toEqual(['plan-dupe']);
  });

  test('the duplicate removal passes suppressAuth too', async () => {
    install([
      ...existing(),
      { _id: 'plan-dupe', key: 'cdw', label: 'CDW (duplicate)', pricePerDay: 99 },
    ]);
    await save({ _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 12 });
    expect(planWrites('remove')[0].options).toEqual({ suppressAuth: true });
  });
});

describe('saving a row that does not exist yet', () => {
  test('inserts with suppressAuth as the options argument', async () => {
    install([{ _id: 'plan-other', key: 'other', label: 'Other', pricePerDay: 1 }]);
    await save({ key: 'scdw', label: 'Super CDW', pricePerDay: 20 });

    const [write] = planWrites('insert');
    expect(write.options).toEqual({ suppressAuth: true });
    expect(write.item).not.toHaveProperty('suppressAuth');
    expect(planRow('scdw')).toMatchObject({ label: 'Super CDW', pricePerDay: 20 });
  });

  test('normalizes the key from the label when none is supplied', async () => {
    install([{ _id: 'plan-other', key: 'other', label: 'Other', pricePerDay: 1 }]);
    await save({ label: 'Super CDW', pricePerDay: 20 });
    expect(fake.rows(COLLECTION).map((r) => r.key)).toContain('super_cdw');
  });

  test('is audited as an insert, with nothing before it', async () => {
    install([{ _id: 'plan-other', key: 'other', label: 'Other', pricePerDay: 1 }]);
    await save({ key: 'scdw', label: 'Super CDW', pricePerDay: 20 });

    const entry = fake.rows('StaffAuditLog').find((e) => e.action === 'pricing.insert');
    expect(entry).toBeDefined();
    expect(entry.oldValue).toBe('');
  });

  test('an empty id on the payload does not become a stored field', async () => {
    install([{ _id: 'plan-other', key: 'other', label: 'Other', pricePerDay: 1 }]);
    await save({ _id: '', key: 'scdw', label: 'Super CDW', pricePerDay: 20 });

    const [write] = planWrites('insert');
    expect(write.item._id).not.toBe('');
  });
});

describe('the gate in front of it', () => {
  test('refuses an unauthenticated caller, and writes nothing', async () => {
    install([{ _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 10 }]);

    await expect(upsertInsurancePlan({ payload: { key: 'cdw', label: 'Hacked', pricePerDay: 0 } }))
      .rejects.toThrow('AUTH_REQUIRED');
    expect(planWrites('update')).toHaveLength(0);
    expect(planWrites('insert')).toHaveLength(0);
    expect(planRow('cdw').label).toBe('CDW');
  });

  test('refuses a negative price before anything is written', async () => {
    install([{ _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 10 }]);

    await expect(save({ _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: -5 }))
      .rejects.toThrow('Invalid insurance pricePerDay');
    expect(planRow('cdw').pricePerDay).toBe(10);
  });
});
