import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import * as admin from '../pricingAdmin.jsw';
import { clearPricingCatalogCache } from '../pricingCatalog.jsw';

// What an admin's form payload becomes once it is stored. The existing pricing
// suites cover who may save (auth), that negative prices are refused, and the
// upsert-by-key mechanics; none of them look at the shaping in between.
//
// That shaping is where the money is decided. A category rate rule carries the
// daily price and the day band it applies to, and the band is read back with
// `days < minDays` / `maxDays > 0 && days > maxDays` — so a band stored wrongly
// does not error, it just silently stops matching, and the customer falls
// through to a different rate.

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';

function seed(extra = {}) {
  const passwordSalt = randomHex(16);
  return {
    StaffRoles: [{ _id: 'role-admin', key: 'admin', label: 'Administrator', active: true }],
    StaffUsers: [{ _id: 'user-1', email: EMAIL, fullName: 'Admin User', roleKey: 'admin', active: true }],
    StaffCredentials: [{
      _id: 'cred-1', email: EMAIL, passwordSalt,
      passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true,
    }],
    StaffSessions: [],
    StaffAuditLog: [],
    CategoryRateRules: [],
    PricingSeasons: [],
    PickupLocations: [],
    VehiclesNew: [],
    FleetNew: [],
    ...extra,
  };
}

let fake;
function install(s = seed()) {
  fake = createFakeWixData(s).install(wixData);
  return fake;
}
async function token() {
  const { sessionToken } = await loginStaff({ email: EMAIL, password: PASSWORD });
  return sessionToken;
}

beforeEach(() => clearPricingCatalogCache());
afterEach(() => {
  if (fake) fake.restore();
  fake = null;
  clearPricingCatalogCache();
});

describe('category rate rules — the record that sets the daily price', () => {
  const save = async (payload) => admin.upsertCategoryRateRule({ authToken: await token(), payload });

  test('the price is stored as a number', async () => {
    install();
    const saved = await save({ label: 'ECO high season', categoryCode: 'ECO', pricePerDay: '45.50' });
    expect(saved.pricePerDay).toBe(45.5);
  });

  test('a non-numeric price becomes zero rather than NaN', async () => {
    // NaN would be stored and then fail every comparison downstream in silence.
    install();
    const saved = await save({ label: 'ECO', categoryCode: 'ECO', pricePerDay: 'free' });
    expect(saved.pricePerDay).toBe(0);
  });

  test('the category code is upper-cased, so "eco" and "ECO" are one rule', async () => {
    // Lookups compare upper-cased codes. Stored lower-case, the rule would
    // never be found and the category would fall back to its base price.
    install();
    const saved = await save({ label: 'ECO', categoryCode: 'eco', pricePerDay: 40 });
    expect(saved.categoryCode).toBe('ECO');
  });

  test.each([
    ['a day band below one', { minDays: 0 }, 1],
    ['a negative day band', { minDays: -5 }, 1],
    ['a fractional band', { minDays: 3.7 }, 3],
    ['a missing band', {}, 1],
  ])('%s is stored as a whole number of at least one', async (_label, over, expected) => {
    install();
    const saved = await save({ label: 'ECO', categoryCode: 'ECO', pricePerDay: 40, ...over });
    expect(saved.minDays).toBe(expected);
  });

  test('an unbounded upper limit is stored as zero, not as a negative', async () => {
    // Read back as `maxDays > 0 && days > maxDays`, so zero means "no ceiling".
    install();
    const saved = await save({ label: 'ECO', categoryCode: 'ECO', pricePerDay: 40, maxDays: -3 });
    expect(saved.maxDays).toBe(0);
  });

  test('a fractional upper limit is floored', async () => {
    install();
    const saved = await save({ label: 'ECO', categoryCode: 'ECO', pricePerDay: 40, maxDays: 7.9 });
    expect(saved.maxDays).toBe(7);
  });

  test('the season key is slugged so it matches the season record', async () => {
    // A rate rule points at a season by key. Stored unslugged, the two never
    // meet and the seasonal price silently does not apply.
    install();
    const saved = await save({ label: 'ECO', categoryCode: 'ECO', pricePerDay: 40, seasonKey: 'High Season 2026' });
    expect(saved.seasonKey).toBe('high_season_2026');
  });

  test('a rule with no key or label is identified by its category, season and band', async () => {
    // No label on purpose. With one, the key is derived from the label and the
    // generated template is never exercised — an assertion that looks like it
    // covers the template but does not.
    install();
    const saved = await save({ categoryCode: 'ECO', seasonKey: 'high', minDays: 7, maxDays: 14, pricePerDay: 40 });
    expect(saved.key).toBe('eco_high_7_14');
  });

  test('two unlabelled rules for different bands do not collide', async () => {
    // The generated key is the only thing keeping them apart. If it dropped the
    // band, the second save would overwrite the first and one price band would
    // quietly disappear.
    install();
    await save({ categoryCode: 'ECO', seasonKey: 'high', minDays: 1, maxDays: 6, pricePerDay: 50 });
    await save({ categoryCode: 'ECO', seasonKey: 'high', minDays: 7, maxDays: 14, pricePerDay: 35 });

    const rows = fake.rows('CategoryRateRules');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.pricePerDay).sort((a, b) => a - b)).toEqual([35, 50]);
  });

  test('saving the same band twice updates rather than duplicating', async () => {
    // Two rules for one band would make the rate depend on iteration order.
    install();
    const payload = { label: 'ECO high 7-14', categoryCode: 'ECO', seasonKey: 'high', minDays: 7, maxDays: 14 };
    await save({ ...payload, pricePerDay: 40 });
    await save({ ...payload, pricePerDay: 35 });

    const rows = fake.rows('CategoryRateRules');
    expect(rows).toHaveLength(1);
    expect(rows[0].pricePerDay).toBe(35);
  });

  test('rules for different bands of the same category coexist', async () => {
    install();
    await save({ label: 'ECO short', categoryCode: 'ECO', minDays: 1, maxDays: 6, pricePerDay: 50 });
    await save({ label: 'ECO long', categoryCode: 'ECO', minDays: 7, maxDays: 0, pricePerDay: 35 });
    expect(fake.rows('CategoryRateRules')).toHaveLength(2);
  });

  test('a rule may be attached by category id instead of code', async () => {
    install();
    const saved = await save({ label: 'By id', vehicleCategoryId: 'cat-eco', pricePerDay: 40 });
    expect(saved.vehicleCategoryId).toBe('cat-eco');
  });

  test('a rule with neither a code nor a category id is refused', async () => {
    // It could never be matched to anything, so storing it is worse than
    // failing: it would sit in the admin list looking active.
    install();
    await expect(save({ label: 'Orphan', pricePerDay: 40 })).rejects.toThrow('Missing category for rate rule');
    expect(fake.rows('CategoryRateRules')).toHaveLength(0);
  });

  test('a negative price is refused and nothing is stored', async () => {
    install();
    await expect(save({ label: 'ECO', categoryCode: 'ECO', pricePerDay: -1 })).rejects.toThrow('Invalid rate rule price');
    expect(fake.rows('CategoryRateRules')).toHaveLength(0);
  });

  test('a rule is active and publicly visible unless said otherwise', async () => {
    install();
    const saved = await save({ label: 'ECO', categoryCode: 'ECO', pricePerDay: 40 });
    expect(saved.active).toBe(true);
    expect(saved.publicVisible).toBe(true);
  });

  test('a rule can be stored deactivated', async () => {
    install();
    const saved = await save({ label: 'ECO', categoryCode: 'ECO', pricePerDay: 40, active: false });
    expect(saved.active).toBe(false);
  });

  test('an inverted band is refused rather than stored unusable', async () => {
    // minDays 10 with maxDays 2 can never match: the reader wants
    // days >= minDays and days <= maxDays. Saved, it sat in the admin list
    // looking active while never applying to a booking.
    install();
    await expect(save({ label: 'Inverted', categoryCode: 'ECO', pricePerDay: 40, minDays: 10, maxDays: 2 }))
      .rejects.toThrow('Invalid rate rule day band');
    expect(fake.rows('CategoryRateRules')).toHaveLength(0);
  });

  test('an open-ended band is still allowed', async () => {
    // maxDays 0 means "no ceiling" and is below minDays numerically, so the
    // guard has to exempt it or every long-stay rule becomes unsavable.
    install();
    const saved = await save({ label: 'Long stay', categoryCode: 'ECO', pricePerDay: 35, minDays: 7, maxDays: 0 });
    expect(saved).toMatchObject({ minDays: 7, maxDays: 0 });
  });

  test('a band whose ends meet is allowed', async () => {
    // Exactly one day wide: minDays === maxDays is a real band, not an
    // inversion.
    install();
    const saved = await save({ label: 'Single day', categoryCode: 'ECO', pricePerDay: 60, minDays: 3, maxDays: 3 });
    expect(saved).toMatchObject({ minDays: 3, maxDays: 3 });
  });
});

describe('pricing seasons', () => {
  const save = async (payload) => admin.upsertPricingSeason({ authToken: await token(), payload });

  test('a season is stored with a slugged key', async () => {
    install();
    const saved = await save({ label: 'High Season', startDate: '2026-06-01', endDate: '2026-09-15' });
    expect(saved.key).toBe('high_season');
    expect(saved.label).toBe('High Season');
  });

  test('accented labels slug to plain ascii', async () => {
    // The key is matched against rate rules, so it has to be stable regardless
    // of how the label was typed.
    install();
    const saved = await save({ label: 'Καλοκαίρι Peak', startDate: '2026-06-01', endDate: '2026-09-15' });
    expect(saved.key).toMatch(/^[a-z0-9_]+$/);
  });

  test('a season with no label is refused', async () => {
    // The guard used to read `if (!normalized.label)`, which could never fire —
    // the normalizer defaults the label to the literal 'Season'. It now checks
    // the payload.
    install();
    await expect(save({ startDate: '2026-06-01', endDate: '2026-09-15' }))
      .rejects.toThrow('Missing pricing season label');
    expect(fake.rows('PricingSeasons')).toHaveLength(0);
  });

  test('a season titled instead of labelled is accepted', async () => {
    install();
    expect((await save({ title: 'High Season', startDate: '2026-06-01', endDate: '2026-09-15' })).label).toBe('High Season');
  });

  test.each([
    ['no dates at all', {}],
    ['only a start date', { startDate: '2026-06-01' }],
    ['only an end date', { endDate: '2026-09-15' }],
  ])('a season with %s is refused', async (_label, over) => {
    install();
    await expect(save({ label: 'High', ...over })).rejects.toThrow('Missing pricing season dates');
    expect(fake.rows('PricingSeasons')).toHaveLength(0);
  });

  test('start and end accept the alternative field names the admin form sends', async () => {
    install();
    const saved = await save({ label: 'High', start: '2026-06-01', end: '2026-09-15' });
    expect(saved.startDate).toBe('2026-06-01');
    expect(saved.endDate).toBe('2026-09-15');
  });

  test('a season does not repeat yearly unless asked', async () => {
    // Defaulting this on would silently apply last summer's prices to every
    // future summer.
    install();
    const saved = await save({ label: 'One off', startDate: '2026-06-01', endDate: '2026-09-15' });
    expect(saved.repeatYearly).toBe(false);
  });

  test('a repeating season can be stored', async () => {
    install();
    const saved = await save({ label: 'Every summer', startDate: '2026-06-01', endDate: '2026-09-15', repeatYearly: true });
    expect(saved.repeatYearly).toBe(true);
  });

  test('priority is stored as a number so seasons can be ordered', async () => {
    install();
    const saved = await save({ label: 'High', startDate: '2026-06-01', endDate: '2026-09-15', priority: '10' });
    expect(saved.priority).toBe(10);
  });

  test('a non-numeric priority becomes zero rather than NaN', async () => {
    install();
    const saved = await save({ label: 'High', startDate: '2026-06-01', endDate: '2026-09-15', priority: 'urgent' });
    expect(saved.priority).toBe(0);
  });

  test('two differently named seasons do not collide', async () => {
    // The key is derived from the label. Two seasons sharing a key would mean
    // the second silently overwrites the first.
    install();
    await save({ label: 'High Season', startDate: '2026-06-01', endDate: '2026-09-15' });
    await save({ label: 'Christmas', startDate: '2026-12-01', endDate: '2027-01-10' });
    expect(fake.rows('PricingSeasons')).toHaveLength(2);
  });

  test('saving the same season twice updates rather than duplicating', async () => {
    install();
    await save({ label: 'High Season', startDate: '2026-06-01', endDate: '2026-09-15', priority: 1 });
    await save({ label: 'High Season', startDate: '2026-06-01', endDate: '2026-09-20', priority: 2 });
    const rows = fake.rows('PricingSeasons');
    expect(rows).toHaveLength(1);
    expect(rows[0].endDate).toBe('2026-09-20');
  });
});

describe('vehicle categories', () => {
  const save = async (payload) => admin.upsertVehicleCategory({ authToken: await token(), payload });

  test('the category code is upper-cased', async () => {
    install();
    const saved = await save({ category: 'eco', title: 'Economy', price: 45 });
    expect(saved.category).toBe('ECO');
  });

  test('the price is stored as a number', async () => {
    install();
    expect((await save({ category: 'ECO', title: 'Economy', price: '45.5' })).price).toBe(45.5);
  });

  test('a non-numeric price becomes zero', async () => {
    install();
    expect((await save({ category: 'ECO', title: 'Economy', price: 'ask' })).price).toBe(0);
  });

  test('a category with no title falls back to its code', async () => {
    install();
    expect((await save({ category: 'ECO', price: 45 })).title).toBe('ECO');
  });

  test('a category is active, visible and air-conditioned unless said otherwise', async () => {
    // These defaults decide whether a category appears on the public site at
    // all, so defaulting them off would empty the booking page.
    install();
    const saved = await save({ category: 'ECO', title: 'Economy', price: 45 });
    expect(saved.active).toBe(true);
    expect(saved.publicVisible).toBe(true);
    expect(saved.airCondition).toBe(true);
  });

  test('a category can be hidden from the public site while staying active', async () => {
    install();
    const saved = await save({ category: 'ECO', title: 'Economy', price: 45, publicVisible: false });
    expect(saved.publicVisible).toBe(false);
    expect(saved.active).toBe(true);
  });

  test('an unordered category sorts last rather than first', async () => {
    install();
    expect((await save({ category: 'ECO', title: 'Economy', price: 45 })).sortOrder).toBe(9999);
  });

  test('a category with neither a code nor a title is refused on the code', async () => {
    // There is no title guard: the title falls back to the code, which is a
    // useful shortcut rather than an accident, so the code is the field that
    // actually has to be there. An unreachable title guard used to sit above
    // this one and has been removed — the error a caller sees is unchanged.
    install();
    await expect(admin.upsertVehicleCategory({ authToken: await token(), payload: { price: 45 } }))
      .rejects.toThrow('Missing vehicle category code');
    expect(fake.rows('VehiclesNew')).toHaveLength(0);
  });

  test('a category with only a code is still accepted', async () => {
    // The shortcut the missing title guard leaves open, pinned so removing it
    // is a deliberate choice rather than a side effect.
    install();
    expect((await save({ category: 'ECO', price: 45 })).title).toBe('ECO');
  });

  test('the admin list shows the code alongside the title', async () => {
    install();
    expect((await save({ category: 'eco', title: 'Economy', price: 45 })).displayTitle).toBe('ECO - Economy');
  });

  test('a category with no title of its own displays its code twice', async () => {
    // The display title is built from the normalized row, where the title has
    // already been defaulted to the code — so it reads "ECO - ECO". Cosmetic,
    // pinned rather than changed, and reported.
    install();
    expect((await save({ category: 'ECO', price: 45 })).displayTitle).toBe('ECO - ECO');
  });

  test.each([
    ['a Wix media reference', 'wix:image://v1/abc123~mv2.jpg/car.jpg#originWidth=1', 'https://static.wixstatic.com/media/abc123~mv2.jpg'],
    ['an https url', 'https://cdn.example/car.jpg', 'https://cdn.example/car.jpg'],
    ['an http url', 'http://cdn.example/car.jpg', 'http://cdn.example/car.jpg'],
    ['an empty image', '', ''],
  ])('%s resolves to a usable image url', async (_label, image, expected) => {
    // A Wix media reference is not a URL a browser can load; left unconverted
    // the public site shows a broken image rather than an error.
    install();
    expect((await save({ category: 'ECO', title: 'Economy', price: 45, image })).imageUrl).toBe(expected);
  });

  test('an image given as an object is unwrapped', async () => {
    install();
    const saved = await save({ category: 'ECO', title: 'Economy', price: 45, image: { src: 'https://cdn.example/a.jpg' } });
    expect(saved.imageUrl).toBe('https://cdn.example/a.jpg');
  });

  test.each([
    ['true', true], ['"true"', 'true'], ['"yes"', 'yes'], ['1', 1], ['"on"', 'on'],
  ])('%s is read as an enabled flag', async (_label, value) => {
    install();
    expect((await save({ category: 'ECO', title: 'E', price: 1, publicVisible: value })).publicVisible).toBe(true);
  });

  test.each([
    ['false', false], ['"false"', 'false'], ['"no"', 'no'], ['0', 0],
  ])('%s is read as a disabled flag', async (_label, value) => {
    install();
    expect((await save({ category: 'ECO', title: 'E', price: 1, publicVisible: value })).publicVisible).toBe(false);
  });
});

describe('pickup locations', () => {
  // An address is required, so every payload here carries one.
  const save = async (payload) => admin.upsertPickupLocation({
    authToken: await token(), payload: { address: 'Somewhere 1, Thessaloniki', ...payload },
  });

  test('a location with no address is refused', async () => {
    install();
    await expect(admin.upsertPickupLocation({ authToken: await token(), payload: { label: 'Airport', address: '' } }))
      .rejects.toThrow('Missing pickup location address');
    expect(fake.rows('PickupLocations')).toHaveLength(0);
  });

  test('a location with no label is refused', async () => {
    // The guard used to read `if (!normalized.label)`, which could never fire —
    // the normalizer defaults the label to the literal 'Location'. Unlabelled
    // locations were stored and several of them all read "Location" in the
    // admin list. It now checks the payload.
    install();
    await expect(save({ label: '' })).rejects.toThrow('Missing pickup location label');
    expect(fake.rows('PickupLocations')).toHaveLength(0);
  });

  test('a location titled instead of labelled is accepted', async () => {
    // The normalizer reads either field, so the guard has to as well.
    install();
    expect((await save({ label: '', title: 'Airport' })).label).toBe('Airport');
  });

  test('the surcharge is stored as a number', async () => {
    install();
    expect((await save({ label: 'Airport', extraFee: '15.5' })).extraFee).toBe(15.5);
  });

  test('a non-numeric surcharge becomes zero rather than NaN', async () => {
    // This is added straight into a booking total.
    install();
    expect((await save({ label: 'Airport', extraFee: 'varies' })).extraFee).toBe(0);
  });

  test('the surcharge accepts the alternative field names the form sends', async () => {
    install();
    expect((await save({ label: 'Airport', fee: 12 })).extraFee).toBe(12);
  });

  test('a location with no surcharge costs nothing', async () => {
    install();
    expect((await save({ label: 'Office' })).extraFee).toBe(0);
  });

  test('a location serves both pickup and dropoff unless told otherwise', async () => {
    install();
    expect((await save({ label: 'Office' })).locationType).toBe('both');
  });

  test('a location gets a default station rather than an empty one', async () => {
    install();
    const saved = await save({ label: 'Office' });
    expect(saved.stationKey).toBe('default');
    expect(saved.stationLabel).toBeTruthy();
  });

  test('the key is slugged from the label', async () => {
    install();
    expect((await save({ label: 'Thessaloniki Airport' })).key).toBe('thessaloniki_airport');
  });

  test('saving the same location twice updates rather than duplicating', async () => {
    install();
    await save({ label: 'Airport', extraFee: 10 });
    await save({ label: 'Airport', extraFee: 15 });
    const rows = fake.rows('PickupLocations');
    expect(rows).toHaveLength(1);
    expect(rows[0].extraFee).toBe(15);
  });
});

describe('fleet vehicles', () => {
  // Plate, model and category are all required, so the defaults below supply them.
  const save = async (payload) => admin.upsertFleetVehicle({
    authToken: await token(), payload: { category: 'ECO', ...payload },
  });

  test.each([
    ['no plate', { plate: '', model: 'Aygo' }, 'Missing fleet plate'],
    ['no model', { plate: 'AAA-1111', model: '' }, 'Missing fleet model'],
    ['no category', { plate: 'AAA-1111', model: 'Aygo', category: '' }, 'Missing fleet category'],
  ])('a vehicle with %s is refused', async (_l, payload, message) => {
    install();
    await expect(admin.upsertFleetVehicle({ authToken: await token(), payload }))
      .rejects.toThrow(message);
    expect(fake.rows('FleetNew')).toHaveLength(0);
  });

  test('the plate is upper-cased', async () => {
    // Plates are matched by string elsewhere; a lower-case one would read as a
    // different vehicle.
    install();
    expect((await save({ plate: 'aaa-1111', model: 'Aygo' })).plate).toBe('AAA-1111');
  });

  test('a vehicle takes its model from the title when no model is given', async () => {
    install();
    expect((await save({ plate: 'AAA-1111', title: 'Aygo' })).model).toBe('Aygo');
  });

  test('the category code is upper-cased', async () => {
    install();
    expect((await save({ plate: 'AAA-1111', model: 'Aygo', category: 'eco' })).category).toBe('ECO');
  });

  test('a vehicle is active with an available status unless said otherwise', async () => {
    install();
    const saved = await save({ plate: 'AAA-1111', model: 'Aygo' });
    expect(saved.active).toBe(true);
    expect(saved.status).toBe('available');
  });

  test('a deactivated vehicle takes an inactive status', async () => {
    install();
    const saved = await save({ plate: 'AAA-1111', model: 'Aygo', active: false });
    expect(saved.active).toBe(false);
    expect(saved.status).toBe('inactive');
  });
});

describe('every pricing change is audited', () => {
  // The audit trail is what makes a price change answerable for later.
  // Authenticating writes its own 'staffAuth' entry, so filter to pricing ones —
  // otherwise a test asserting 'an audit was written' passes on the login.
  const auditRows = () => fake.calls.insert.filter(
    (c) => c.collection === 'StaffAuditLog' && String(c.item?.entityType || '').startsWith('pricing'),
  );

  test.each([
    ['a rate rule', () => admin.upsertCategoryRateRule, { label: 'ECO', categoryCode: 'ECO', pricePerDay: 40 }],
    ['a season', () => admin.upsertPricingSeason, { label: 'High', startDate: '2026-06-01', endDate: '2026-09-15' }],
    ['a pickup location', () => admin.upsertPickupLocation, { label: 'Airport', address: 'Somewhere 1', extraFee: 10 }],
    ['a vehicle category', () => admin.upsertVehicleCategory, { category: 'ECO', title: 'Economy', price: 45 }],
  ])('saving %s writes an audit entry with suppressAuth', async (_label, getFn, payload) => {
    install();
    await getFn()({ authToken: await token(), payload });
    const entry = auditRows().at(-1);
    expect(entry).toBeDefined();
    expect(entry.options).toEqual({ suppressAuth: true });
    expect(entry.item.suppressAuth).toBeUndefined();
  });

  test('the audit says who made the change', async () => {
    install();
    await admin.upsertCategoryRateRule({
      authToken: await token(), payload: { label: 'ECO', categoryCode: 'ECO', pricePerDay: 40 },
    });
    expect(JSON.stringify(auditRows().at(-1).item)).toContain(EMAIL);
  });

  test('a refused change writes no audit entry', async () => {
    // Recording a change that did not happen is worse than recording nothing.
    install();
    await admin.upsertCategoryRateRule({
      authToken: await token(), payload: { label: 'Bad', categoryCode: 'ECO', pricePerDay: -5 },
    }).catch(() => {});
    expect(auditRows()).toHaveLength(0);
  });
});
