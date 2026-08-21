import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import { seedPricingDefaults, resetPricingDefaults } from '../pricingAdmin.jsw';
import { getPricingCatalog, getFallbackCatalogSnapshot, clearPricingCatalogCache } from '../pricingCatalog.jsw';

// Seed and reset are the two destructive buttons on the pricing admin, and the
// difference between them is the whole point:
//
//   seed  fills in what is missing and leaves everything else alone
//   reset overwrites back to the defaults
//
// If seed ever behaved like reset, an operator clicking "seed defaults" to pick
// up a newly added extra would silently revert every price they had set. Both
// are .jsw exports, both were uncovered.
//
// The auth gate on both is already covered in pricingAdminCrud; what is asserted
// here is what they do to the data once past it.

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';

const COLLECTIONS = {
  business: 'BusinessSettings',
  insurance: 'InsurancePlans',
  extras: 'ExtraServices',
  fees: 'FeeRules',
};

const FALLBACK = getFallbackCatalogSnapshot();
// scdw is 12 in the defaults; cdw is deliberately 0, which is the interesting one.
const DEFAULT_SCDW = FALLBACK.insurancePlans.find((p) => p.key === 'scdw').pricePerDay;
const DEFAULT_GPS = FALLBACK.extraServices.find((e) => e.key === 'gps').price;

function staffSeed(extra = {}) {
  const passwordSalt = randomHex(16);
  return {
    StaffRoles: [{ _id: 'role-admin', key: 'admin', label: 'Administrator', active: true, sortOrder: 1 }],
    StaffUsers: [{ _id: 'user-1', email: EMAIL, fullName: 'Admin User', roleKey: 'admin', active: true }],
    StaffCredentials: [{
      _id: 'cred-1',
      email: EMAIL,
      passwordSalt,
      passwordHash: derivePasswordHash(PASSWORD, passwordSalt),
      active: true,
    }],
    StaffSessions: [],
    StaffAuditLog: [],
    ...extra,
  };
}

let fake;
function install(seed = staffSeed()) {
  clearPricingCatalogCache();
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
  clearPricingCatalogCache();
});

/** The stored row for a key, whatever else is in the collection. */
function row(collection, key) {
  return fake.rows(collection).find((r) => r.key === key);
}

/** A collection pre-populated so ensurePricingSeeded leaves it alone. */
function withInsurance(rows) {
  return staffSeed({ [COLLECTIONS.insurance]: rows });
}

describe('seeding defaults leaves what the operator set', () => {
  test('a customised price survives', async () => {
    // The one that costs money if it breaks.
    install(withInsurance([{ _id: 'p1', key: 'scdw', label: 'Super CDW', pricePerDay: 99, billingMode: 'perDay', active: true }]));
    const token = await adminToken();

    await seedPricingDefaults({ authToken: token, target: 'insurance' });

    expect(row(COLLECTIONS.insurance, 'scdw').pricePerDay).toBe(99);
    expect(DEFAULT_SCDW).not.toBe(99); // the default really would have changed it
  });

  test('a customised label survives', async () => {
    install(withInsurance([{ _id: 'p1', key: 'scdw', label: 'Our own name for it', pricePerDay: 99, active: true }]));
    const token = await adminToken();

    await seedPricingDefaults({ authToken: token, target: 'insurance' });

    expect(row(COLLECTIONS.insurance, 'scdw').label).toBe('Our own name for it');
  });

  test('a price deliberately set to zero is not treated as missing', async () => {
    // Zero is a real price — a free plan — and blanking it back to a default
    // would start charging for something advertised as included.
    install(withInsurance([{ _id: 'p1', key: 'scdw', label: 'Free tier', pricePerDay: 0, active: true }]));
    const token = await adminToken();

    await seedPricingDefaults({ authToken: token, target: 'insurance' });

    expect(row(COLLECTIONS.insurance, 'scdw').pricePerDay).toBe(0);
  });

  test('a flag deliberately set to false is not flipped back to true', async () => {
    install(withInsurance([{ _id: 'p1', key: 'scdw', label: 'Super CDW', pricePerDay: 99, active: true, publicVisible: false }]));
    const token = await adminToken();

    await seedPricingDefaults({ authToken: token, target: 'insurance' });

    expect(row(COLLECTIONS.insurance, 'scdw').publicVisible).toBe(false);
  });
});

describe('seeding defaults fills what is missing', () => {
  test('a blank field is filled from the default', async () => {
    install(withInsurance([{ _id: 'p1', key: 'scdw', label: '', pricePerDay: 99, active: true }]));
    const token = await adminToken();

    await seedPricingDefaults({ authToken: token, target: 'insurance' });

    const saved = row(COLLECTIONS.insurance, 'scdw');
    expect(saved.label).toBeTruthy();
    expect(saved.pricePerDay).toBe(99); // and the price it did have is still there
  });

  test('a non-numeric price is replaced', async () => {
    install(withInsurance([{ _id: 'p1', key: 'scdw', label: 'Super CDW', pricePerDay: 'ask the desk', active: true }]));
    const token = await adminToken();

    await seedPricingDefaults({ authToken: token, target: 'insurance' });

    expect(row(COLLECTIONS.insurance, 'scdw').pricePerDay).toBe(DEFAULT_SCDW);
  });

  test('a default row the collection has never had is inserted', async () => {
    install(withInsurance([{ _id: 'p1', key: 'scdw', label: 'Super CDW', pricePerDay: 99, active: true }]));
    const token = await adminToken();

    const result = await seedPricingDefaults({ authToken: token, target: 'insurance' });

    expect(row(COLLECTIONS.insurance, 'full')).toBeDefined();
    expect(result.insurance.inserted).toBeGreaterThan(0);
  });

  test('a row that gets filled in is counted as updated', async () => {
    // The insert and no-op counts are asserted elsewhere; this is the third
    // branch, and the one an operator reads to tell whether seeding did anything.
    install(withInsurance([{ _id: 'p1', key: 'scdw', label: '', pricePerDay: 99, active: true }]));
    const token = await adminToken();

    const result = await seedPricingDefaults({ authToken: token, target: 'insurance' });

    expect(result.insurance.updated).toBe(1);
  });

  test('the counts report what actually happened', async () => {
    install(withInsurance([{ _id: 'p1', key: 'scdw', label: 'Super CDW', pricePerDay: 99, active: true, publicVisible: true, sortOrder: 1, description: 'x' }]));
    const token = await adminToken();

    const result = await seedPricingDefaults({ authToken: token, target: 'insurance' });

    expect(result.insurance.total).toBe(FALLBACK.insurancePlans.length);
    expect(result.insurance.inserted).toBe(FALLBACK.insurancePlans.length - 1);
  });

  test('running it twice changes nothing the second time', async () => {
    // Seeding has to be safe to click again, or an operator learns not to.
    install();
    const token = await adminToken();
    await seedPricingDefaults({ authToken: token, target: 'insurance' });

    const before = fake.rows(COLLECTIONS.insurance);
    const second = await seedPricingDefaults({ authToken: token, target: 'insurance' });

    expect(fake.rows(COLLECTIONS.insurance)).toEqual(before);
    expect(second.insurance.inserted).toBe(0);
    expect(second.insurance.updated).toBe(0);
  });
});

describe('resetting defaults overwrites', () => {
  test('a customised price goes back to the default', async () => {
    // The difference from seed, stated as plainly as possible.
    install(withInsurance([{ _id: 'p1', key: 'scdw', label: 'Super CDW', pricePerDay: 99, active: true }]));
    const token = await adminToken();

    await resetPricingDefaults({ authToken: token, target: 'insurance' });

    expect(row(COLLECTIONS.insurance, 'scdw').pricePerDay).toBe(DEFAULT_SCDW);
  });

  test('a customised label goes back too', async () => {
    install(withInsurance([{ _id: 'p1', key: 'scdw', label: 'Our own name for it', pricePerDay: 99, active: true }]));
    const token = await adminToken();

    await resetPricingDefaults({ authToken: token, target: 'insurance' });

    expect(row(COLLECTIONS.insurance, 'scdw').label).not.toBe('Our own name for it');
  });

  test('the row keeps its id, so anything pointing at it still resolves', async () => {
    install(withInsurance([{ _id: 'p1', key: 'scdw', label: 'Super CDW', pricePerDay: 99, active: true }]));
    const token = await adminToken();

    await resetPricingDefaults({ authToken: token, target: 'insurance' });

    expect(row(COLLECTIONS.insurance, 'scdw')._id).toBe('p1');
  });

  test('a missing default row is inserted rather than skipped', async () => {
    install(withInsurance([{ _id: 'p1', key: 'scdw', label: 'Super CDW', pricePerDay: 99, active: true }]));
    const token = await adminToken();

    const result = await resetPricingDefaults({ authToken: token, target: 'insurance' });

    expect(row(COLLECTIONS.insurance, 'full')).toBeDefined();
    expect(result.insurance.inserted + result.insurance.updated).toBe(FALLBACK.insurancePlans.length);
  });

  test('a row the operator added that is not in the defaults is left alone', async () => {
    // Reset restores the defaults; it is not a purge of everything else.
    install(withInsurance([
      { _id: 'p1', key: 'scdw', label: 'Super CDW', pricePerDay: 99, active: true },
      { _id: 'p2', key: 'housebrand', label: 'House cover', pricePerDay: 30, active: true },
    ]));
    const token = await adminToken();

    await resetPricingDefaults({ authToken: token, target: 'insurance' });

    expect(row(COLLECTIONS.insurance, 'housebrand')).toMatchObject({ pricePerDay: 30 });
  });
});

describe('what a target actually targets', () => {
  // A reset scoped to one part of the catalog must not reach into another.
  function mixedSeed() {
    return staffSeed({
      [COLLECTIONS.insurance]: [{ _id: 'p1', key: 'scdw', label: 'Super CDW', pricePerDay: 99, active: true }],
      [COLLECTIONS.extras]: [{ _id: 'e1', key: 'gps', label: 'GPS', price: 77, billingMode: 'perDay', active: true }],
      [COLLECTIONS.business]: [{ _id: 'b1', currency: 'GBP', companyName: 'Someone Else Ltd', vatRateDecimal: 0.2 }],
    });
  }

  test('resetting extras leaves insurance and business settings untouched', async () => {
    install(mixedSeed());
    const token = await adminToken();

    await resetPricingDefaults({ authToken: token, target: 'extras' });

    expect(row(COLLECTIONS.extras, 'gps').price).toBe(DEFAULT_GPS);
    expect(row(COLLECTIONS.insurance, 'scdw').pricePerDay).toBe(99);
    expect(fake.rows(COLLECTIONS.business)[0].companyName).toBe('Someone Else Ltd');
  });

  test('resetting insurance leaves extras untouched', async () => {
    install(mixedSeed());
    const token = await adminToken();

    await resetPricingDefaults({ authToken: token, target: 'insurance' });

    expect(row(COLLECTIONS.insurance, 'scdw').pricePerDay).toBe(DEFAULT_SCDW);
    expect(row(COLLECTIONS.extras, 'gps').price).toBe(77);
  });

  test('resetting business settings leaves the priced rows untouched', async () => {
    install(mixedSeed());
    const token = await adminToken();

    await resetPricingDefaults({ authToken: token, target: 'business' });

    expect(fake.rows(COLLECTIONS.business)[0].companyName).toBe(FALLBACK.businessSettings.companyName);
    expect(row(COLLECTIONS.insurance, 'scdw').pricePerDay).toBe(99);
    expect(row(COLLECTIONS.extras, 'gps').price).toBe(77);
  });

  test('the default target is everything', async () => {
    install(mixedSeed());
    const token = await adminToken();

    await resetPricingDefaults({ authToken: token });

    expect(row(COLLECTIONS.insurance, 'scdw').pricePerDay).toBe(DEFAULT_SCDW);
    expect(row(COLLECTIONS.extras, 'gps').price).toBe(DEFAULT_GPS);
    expect(fake.rows(COLLECTIONS.business)[0].companyName).toBe(FALLBACK.businessSettings.companyName);
  });

  test('an unrecognised target changes nothing at all', async () => {
    // Better a no-op than a silent fall-through to "everything".
    install(mixedSeed());
    const token = await adminToken();

    await resetPricingDefaults({ authToken: token, target: 'evertything' });

    expect(row(COLLECTIONS.insurance, 'scdw').pricePerDay).toBe(99);
    expect(row(COLLECTIONS.extras, 'gps').price).toBe(77);
    expect(fake.rows(COLLECTIONS.business)[0].companyName).toBe('Someone Else Ltd');
  });

  test('seeding scopes the same way', async () => {
    install(mixedSeed());
    const token = await adminToken();

    const result = await seedPricingDefaults({ authToken: token, target: 'extras' });

    expect(result.insurance.total).toBe(0);
    expect(result.extras.total).toBeGreaterThan(0);
    expect(row(COLLECTIONS.insurance, 'scdw').pricePerDay).toBe(99);
  });
});

describe('business settings', () => {
  test('seeding fills a blank field without touching a set one', async () => {
    install(staffSeed({ [COLLECTIONS.business]: [{ _id: 'b1', companyName: 'Someone Else Ltd', currency: '' }] }));
    const token = await adminToken();

    await seedPricingDefaults({ authToken: token, target: 'business' });

    const [settings] = fake.rows(COLLECTIONS.business);
    expect(settings.companyName).toBe('Someone Else Ltd');
    expect(settings.currency).toBe(FALLBACK.businessSettings.currency);
  });

  test('seeding inserts the singleton when there is none', async () => {
    install();
    const token = await adminToken();

    const result = await seedPricingDefaults({ authToken: token, target: 'business' });

    expect(fake.rows(COLLECTIONS.business)).toHaveLength(1);
    // ensurePricingSeeded creates it first, so seedBusiness finds it and fills nothing.
    expect(result.business.total).toBe(1);
  });

  test('resetting updates the row that is there instead of adding another', async () => {
    // The settings are a singleton by convention: readBusinessSettings takes the
    // oldest row and ignores the rest. The fallback carries an empty _id, and
    // spreading it over the existing row used to blank the real one — so every
    // reset inserted a fresh row, the site kept reading the stale one, and the
    // reset looked like it had done nothing at all.
    install(staffSeed({ [COLLECTIONS.business]: [{ _id: 'b1', companyName: 'Someone Else Ltd', currency: 'GBP' }] }));
    const token = await adminToken();

    await resetPricingDefaults({ authToken: token, target: 'business' });

    expect(fake.rows(COLLECTIONS.business)).toHaveLength(1);
    expect(fake.rows(COLLECTIONS.business)[0]._id).toBe('b1');
  });

  test('resetting twice still leaves one row', async () => {
    install(staffSeed({ [COLLECTIONS.business]: [{ _id: 'b1', companyName: 'Someone Else Ltd', currency: 'GBP' }] }));
    const token = await adminToken();

    await resetPricingDefaults({ authToken: token, target: 'business' });
    await resetPricingDefaults({ authToken: token, target: 'business' });

    expect(fake.rows(COLLECTIONS.business)).toHaveLength(1);
  });

  test('the settings the site reads back are the reset ones', async () => {
    // The assertion that matters to a customer: the quote uses the new VAT rate
    // and currency, not the ones that were replaced.
    install(staffSeed({ [COLLECTIONS.business]: [{ _id: 'b1', companyName: 'Someone Else Ltd', currency: 'GBP', vatRateDecimal: 0.05 }] }));
    const token = await adminToken();

    await resetPricingDefaults({ authToken: token, target: 'business' });

    const catalog = await getPricingCatalog();
    expect(catalog.businessSettings.currency).toBe(FALLBACK.businessSettings.currency);
    expect(catalog.businessSettings.companyName).toBe(FALLBACK.businessSettings.companyName);
  });

  test('resetting overwrites a customised company name', async () => {
    install(staffSeed({ [COLLECTIONS.business]: [{ _id: 'b1', companyName: 'Someone Else Ltd', currency: 'GBP' }] }));
    const token = await adminToken();

    await resetPricingDefaults({ authToken: token, target: 'business' });

    const [settings] = fake.rows(COLLECTIONS.business);
    expect(settings.companyName).toBe(FALLBACK.businessSettings.companyName);
    expect(settings.currency).toBe(FALLBACK.businessSettings.currency);
  });
});

describe('the trail either one leaves', () => {
  test('a reset is written to the pricing audit log', async () => {
    install(withInsurance([{ _id: 'p1', key: 'scdw', label: 'Super CDW', pricePerDay: 99, active: true }]));
    const token = await adminToken();

    await resetPricingDefaults({ authToken: token, target: 'insurance' });

    const entries = fake.rows('StaffAuditLog').filter((e) => e.action === 'pricing.resetDefaults');
    expect(entries.length).toBe(FALLBACK.insurancePlans.length);
    expect(entries[0]).toMatchObject({ actorEmail: EMAIL });
  });

  test('the audit entry keeps the price that was overwritten', async () => {
    // Without the old value the log cannot answer "what did we charge before?".
    install(withInsurance([{ _id: 'p1', key: 'scdw', label: 'Super CDW', pricePerDay: 99, active: true }]));
    const token = await adminToken();

    await resetPricingDefaults({ authToken: token, target: 'insurance' });

    const entries = fake.rows('StaffAuditLog').filter((e) => e.action === 'pricing.resetDefaults');
    expect(JSON.stringify(entries)).toContain('99');
  });

  test('a seed that changes nothing writes no audit entries', async () => {
    install();
    const token = await adminToken();
    await seedPricingDefaults({ authToken: token, target: 'insurance' });
    const after = fake.rows('StaffAuditLog').length;

    await seedPricingDefaults({ authToken: token, target: 'insurance' });

    // Shares a collection with the staff login trail, so count the whole thing:
    // a second seed must add nothing at all.
    expect(fake.rows('StaffAuditLog')).toHaveLength(after);
  });
});

describe('the cached catalog afterwards', () => {
  // The catalog caches for 60 seconds, so a change the cache hides is a change
  // the site keeps quoting the old price for.
  //
  // These assert the outcome, not a particular line: both entry points clear the
  // cache twice over, once via ensurePricingSeeded on the way in and once on the
  // way out. Removing either one alone still leaves the cache empty here, so
  // neither is pinned individually — what is pinned is that a caller who reads
  // the catalog after the call sees the new prices.
  test('a reset is visible to the next read rather than hidden behind the cache', async () => {
    install(withInsurance([{ _id: 'p1', key: 'scdw', label: 'Super CDW', pricePerDay: 99, active: true, publicVisible: true }]));
    const token = await adminToken();

    const before = await getPricingCatalog();
    expect(before.maps.insurance.scdw).toBe(99);

    await resetPricingDefaults({ authToken: token, target: 'insurance' });

    const after = await getPricingCatalog();
    expect(after.maps.insurance.scdw).toBe(DEFAULT_SCDW);
  });

  test('so is a seed', async () => {
    install(withInsurance([{ _id: 'p1', key: 'scdw', label: 'Super CDW', pricePerDay: 99, active: true, publicVisible: true }]));
    const token = await adminToken();

    await getPricingCatalog();
    await seedPricingDefaults({ authToken: token, target: 'insurance' });

    const after = await getPricingCatalog();
    expect(after.maps.insurance.full).toBeDefined();
  });
});

describe('seeding and resetting a site that has no settings row at all', () => {
  // Both endpoints open with `await ensurePricingSeeded()`, which creates the
  // settings row if the collection is empty. So by the time either reaches its
  // own "is there a row?" check, there always is one — and both insert branches
  // are unreachable through the public API. That is pinned below as an update
  // rather than an insert, because it is the observable truth and because the
  // dead branch is worth knowing about before someone edits it.
  const emptySite = () => staffSeed({
    BusinessSettings: [],
    InsurancePlans: [], ExtraServices: [], FeeRules: [],
    PricingSeasons: [], CategoryRateRules: [], PickupLocations: [],
    VehiclesNew: [], FleetNew: [], PricingAuditLog: [],
  });

  test('seeding a site with no settings row leaves exactly one behind', async () => {
    install(emptySite());

    const res = await seedPricingDefaults({ authToken: await adminToken(), target: 'business' });

    // Counted as an update: ensurePricingSeeded put the row there a moment ago.
    expect(res.business).toMatchObject({ inserted: 0, total: 1 });
    expect(fake.rows(COLLECTIONS.business)).toHaveLength(1);
    expect(fake.rows(COLLECTIONS.business)[0].currency).toBe(FALLBACK.businessSettings.currency);
  });

  test('the created row is written to the audit log',  async () => {
    install(emptySite());

    await seedPricingDefaults({ authToken: await adminToken(), target: 'business' });

    expect(fake.rows('StaffAuditLog').some((r) => r.action === 'pricing.seedDefaults')).toBe(true);
  });

  test('seeding twice does not create a second settings row', async () => {
    install(emptySite());
    const authToken = await adminToken();

    await seedPricingDefaults({ authToken, target: 'business' });
    const second = await seedPricingDefaults({ authToken, target: 'business' });

    expect(fake.rows(COLLECTIONS.business)).toHaveLength(1);
    expect(second.business.inserted).toBe(0);
  });

  test('resetting a site with no settings row leaves exactly one behind too', async () => {
    install(emptySite());

    const res = await resetPricingDefaults({ authToken: await adminToken(), target: 'business' });

    expect(res.business).toMatchObject({ inserted: 0, updated: 1, total: 1 });
    expect(fake.rows(COLLECTIONS.business)).toHaveLength(1);
  });

  test('resetting twice updates the same row rather than growing a duplicate', async () => {
    // The failure this guards against is specific and quiet: the shipped
    // defaults carry an empty _id, and left alone every reset inserts a second
    // singleton. readBusinessSettings then takes the oldest row, so the settings
    // the site actually uses never change and the reset looks like it did
    // nothing at all.
    install(emptySite());
    const authToken = await adminToken();

    await resetPricingDefaults({ authToken, target: 'business' });
    const second = await resetPricingDefaults({ authToken, target: 'business' });

    expect(fake.rows(COLLECTIONS.business)).toHaveLength(1);
    expect(second.business).toMatchObject({ inserted: 0, updated: 1 });
  });

  test('a reset is written to the audit log with the previous value', async () => {
    install(emptySite());
    const authToken = await adminToken();
    await resetPricingDefaults({ authToken, target: 'business' });

    await resetPricingDefaults({ authToken, target: 'business' });

    const entries = fake.rows('StaffAuditLog').filter((r) => r.action === 'pricing.resetDefaults');
    expect(entries.length).toBeGreaterThan(1);
    expect(entries[entries.length - 1].oldValue).not.toBe('');
  });

  test('seeding everything on an empty site fills all four collections', async () => {
    install(emptySite());

    await seedPricingDefaults({ authToken: await adminToken(), target: 'all' });

    expect(fake.rows(COLLECTIONS.business)).toHaveLength(1);
    expect(fake.rows(COLLECTIONS.insurance).length).toBeGreaterThan(0);
    expect(fake.rows(COLLECTIONS.extras).length).toBeGreaterThan(0);
    expect(fake.rows(COLLECTIONS.fees).length).toBeGreaterThan(0);
  });
});
