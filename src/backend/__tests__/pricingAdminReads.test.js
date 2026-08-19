import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import {
  getPricingAdminSnapshot,
  saveBusinessSettings,
  upsertPickupLocation,
  exportPricingCatalogSnapshot,
  getStaffPricingCatalog,
  upsertFleetVehicle,
} from '../pricingAdmin.jsw';
import { clearPricingCatalogCache } from '../pricingCatalog.jsw';

// The read side of the pricing admin screen: the snapshot the whole page is
// drawn from, and the two smaller exports beside it.
//
// pricingAdminCrud and pricingAdminNormalize cover the writes. The readers had
// no test at all — including the category lookup that decides which vehicle
// category a fleet row is shown under, and the two failure paths that decide
// whether a missing collection empties one panel or breaks the page.

const ADMIN = 'admin@example.com';
const VIEWER = 'viewer@example.com';
const NOBODY = 'nobody@example.com';
const PASSWORD = 'correct-horse-battery';

// A Wix-shaped record id: long, hex and dashes. The shape matters — the
// category resolver tests against exactly this pattern to decide whether a
// value is a code someone typed or an id the database generated.
const ECO_ID = '8f14e45f-ceea-4e78-9c8f-1a2b3c4d5e6f';

function seed(extra = {}) {
  const passwordSalt = randomHex(16);
  const cred = (email) => ({
    _id: `cred-${email}`, email, passwordSalt,
    passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true,
  });
  return {
    StaffRoles: [
      { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true },
      { _id: 'role-viewer', key: 'viewer', label: 'Viewer', active: true, pricingView: true, specialPermissions: '' },
      { _id: 'role-none', key: 'none', label: 'None', active: true, specialPermissions: '' },
    ],
    StaffUsers: [
      { _id: 'u-1', email: ADMIN, fullName: 'Admin', roleKey: 'admin', active: true },
      { _id: 'u-2', email: VIEWER, fullName: 'Viewer', roleKey: 'viewer', active: true },
      { _id: 'u-3', email: NOBODY, fullName: 'Nobody', roleKey: 'none', active: true },
    ],
    StaffCredentials: [cred(ADMIN), cred(VIEWER), cred(NOBODY)],
    StaffSessions: [],
    StaffAuditLog: [],
    PricingAuditLog: [],
    // Seeded non-empty so ensurePricingSeeded leaves them alone.
    BusinessSettings: [{ _id: 'bs-1', currency: 'EUR' }],
    InsurancePlans: [{ _id: 'i-1', key: 'cdw', label: 'CDW', pricePerDay: 10 }],
    ExtraServices: [{ _id: 'x-1', key: 'gps', label: 'GPS', price: 5 }],
    FeeRules: [{ _id: 'f-1', key: 'night', label: 'Night', amount: 15 }],
    PricingSeasons: [],
    CategoryRateRules: [],
    PickupLocations: [],
    VehiclesNew: [],
    FleetNew: [],
    ...extra,
  };
}

let fake;
function install(extra) {
  clearPricingCatalogCache();
  fake = createFakeWixData(seed(extra)).install(wixData);
  return fake;
}
async function token(email = ADMIN) {
  const { sessionToken } = await loginStaff({ email, password: PASSWORD });
  return sessionToken;
}
const snapshot = async (email = ADMIN) => getPricingAdminSnapshot({ authToken: await token(email) });

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
  clearPricingCatalogCache();
});

describe('who may read the pricing screen', () => {
  test('an unauthenticated caller is refused', async () => {
    install();
    await expect(getPricingAdminSnapshot({})).rejects.toThrow('AUTH_REQUIRED');
    await expect(exportPricingCatalogSnapshot({})).rejects.toThrow('AUTH_REQUIRED');
    await expect(getStaffPricingCatalog({})).rejects.toThrow('AUTH_REQUIRED');
  });

  test('a caller with no pricing access is refused', async () => {
    install();
    const t = await token(NOBODY);
    await expect(getPricingAdminSnapshot({ authToken: t })).rejects.toThrow('ACCESS_DENIED');
    await expect(exportPricingCatalogSnapshot({ authToken: t })).rejects.toThrow('ACCESS_DENIED');
    await expect(getStaffPricingCatalog({ authToken: t })).rejects.toThrow('ACCESS_DENIED');
  });

  test('View is enough to read — these are all gated below Edit', async () => {
    install();
    const res = await snapshot(VIEWER);
    expect(res.businessSettings).toBeTruthy();
  });
});

describe('the snapshot the screen is drawn from', () => {
  test('carries the catalogue and the three admin-only lists', async () => {
    install({
      VehiclesNew: [{ _id: 'v-1', category: 'ECO', title: 'Economy', price: 40 }],
      FleetNew: [{ _id: 'f-1', plate: 'ABC-1234', model: 'Kia Picanto', category: 'ECO' }],
      PickupLocations: [{ _id: 'p-1', key: 'airport', label: 'Airport' }],
    });
    const res = await snapshot();

    expect(res.businessSettings).toBeTruthy();
    expect(res.insurancePlans.length).toBeGreaterThan(0);
    expect(res.vehicleCategories).toHaveLength(1);
    expect(res.fleetVehicles).toHaveLength(1);
    expect(res.pickupLocations).toHaveLength(1);
  });

  test('is built fresh rather than served from the pricing cache', async () => {
    // The admin screen must show what was just saved. Note the freshness does
    // not actually come from the `force: true` on the catalogue read:
    // ensurePricingSeeded runs first and clears the cache outright, so the
    // flag is belt-and-braces. Removing either one alone leaves this passing.
    install();
    await snapshot();
    await wixData.insert('InsurancePlans', { _id: 'i-2', key: 'housecover', label: 'House cover', pricePerDay: 20 }, { suppressAuth: true });

    const res = await snapshot();
    expect(res.insurancePlans.map((p) => p.key)).toContain('housecover');
  });

  test('shows rows the public catalogue hides', async () => {
    // Asserted on a season rather than a pickup location: the snapshot replaces
    // the catalogue's pickupLocations with the admin list, so a hidden pickup
    // row says nothing about the scope the catalogue was read at.
    install({
      PricingSeasons: [{ _id: 's-1', key: 'internal', label: 'Internal', startDate: '2026-06-01', endDate: '2026-09-01', publicVisible: false }],
      PickupLocations: [{ _id: 'p-1', key: 'depot', label: 'Depot', publicVisible: false }],
    });
    const res = await snapshot();
    expect(res.pricingSeasons.map((r) => r.key)).toContain('internal');
    expect(res.pickupLocations.map((p) => p.key)).toContain('depot');
  });
});

describe('the vehicle category list', () => {
  test('shows the code alongside the title', async () => {
    install({ VehiclesNew: [{ _id: 'v-1', category: 'eco', title: 'Economy', price: 40 }] });
    const [row] = (await snapshot()).vehicleCategories;
    expect(row).toMatchObject({ category: 'ECO', title: 'Economy', displayTitle: 'ECO - Economy' });
  });

  test('is ordered by sortOrder, not alphabetically', async () => {
    // The codes deliberately run backwards against the sort order. A fixture
    // where the two agree cannot tell the sort from its own tie-break.
    install({ VehiclesNew: [
      { _id: 'a', category: 'AAA', title: 'Alpha', sortOrder: 30 },
      { _id: 'b', category: 'BBB', title: 'Bravo', sortOrder: 20 },
      { _id: 'c', category: 'CCC', title: 'Charlie', sortOrder: 10 },
    ] });
    expect((await snapshot()).vehicleCategories.map((r) => r.category)).toEqual(['CCC', 'BBB', 'AAA']);
  });

  test('categories sharing a sortOrder fall back to the title shown', async () => {
    // Same order, so only the tie-break can separate them — and the collection
    // order is the reverse of the alphabetical one.
    install({ VehiclesNew: [
      { _id: 'z', category: 'ZZZ', title: 'Zulu', sortOrder: 10 },
      { _id: 'a', category: 'AAA', title: 'Alpha', sortOrder: 10 },
    ] });
    expect((await snapshot()).vehicleCategories.map((r) => r.category)).toEqual(['AAA', 'ZZZ']);
  });

  test('an explicit sortOrder of 0 sorts first, as typing 0 intends', async () => {
    // This used to be the other way round: the comparator used `||`, and since
    // the normaliser has already defaulted a *missing* sortOrder to 9999, the
    // only value `||` still rewrote was a deliberate 0 — which it sent to last.
    install({ VehiclesNew: [
      { _id: 'a', category: 'AAA', title: 'Alpha', sortOrder: 0 },
      { _id: 'b', category: 'ZZZ', title: 'Zulu', sortOrder: 10 },
    ] });
    expect((await snapshot()).vehicleCategories.map((r) => r.category)).toEqual(['AAA', 'ZZZ']);
  });

  test('an unordered category sorts last rather than first', async () => {
    // The unordered one is alphabetically first, so only the 9999 default can
    // put it at the end.
    install({ VehiclesNew: [
      { _id: 'a', category: 'AAA', title: 'Alpha' },
      { _id: 'b', category: 'ZZZ', title: 'Zulu', sortOrder: 10 },
    ] });
    expect((await snapshot()).vehicleCategories.map((r) => r.category)).toEqual(['ZZZ', 'AAA']);
  });

  test('an empty collection gives an empty list — there is no shipped fallback', async () => {
    // The `if (!rows.length)` branch reads like a fallback to a shipped
    // catalogue, but getVehicleCategoriesCatalog queries the very same
    // VehiclesNew collection with a different sort. An empty collection is
    // still empty the second time, so the branch can only ever help when the
    // *first* read failed rather than came back empty.
    install({ VehiclesNew: [] });
    expect((await snapshot()).vehicleCategories).toEqual([]);
  });

  test('only stored rows are listed', async () => {
    install({ VehiclesNew: [{ _id: 'v-1', category: 'ONE', title: 'Only one' }] });
    expect((await snapshot()).vehicleCategories).toHaveLength(1);
  });
});

describe('the fleet list and its category lookup', () => {
  const category = { _id: ECO_ID, category: 'ECO', title: 'Economy', price: 40 };

  test('a vehicle stored with a category code resolves to that category', async () => {
    install({
      VehiclesNew: [category],
      FleetNew: [{ _id: 'f-1', plate: 'abc-1234', model: 'Kia Picanto', category: 'ECO' }],
    });
    const [row] = (await snapshot()).fleetVehicles;
    expect(row).toMatchObject({
      plate: 'ABC-1234', model: 'Kia Picanto',
      category: 'ECO', categoryId: ECO_ID,
      categoryTitle: 'Economy', categoryDisplayTitle: 'ECO - Economy',
    });
  });

  test('the lookup matches the code case-insensitively', async () => {
    install({
      VehiclesNew: [category],
      FleetNew: [{ _id: 'f-1', plate: 'ABC-1234', model: 'Kia Picanto', category: 'eco' }],
    });
    expect((await snapshot()).fleetVehicles[0].categoryTitle).toBe('Economy');
  });

  test('a vehicle whose category is a reference object resolves by id alone', async () => {
    // What a Wix reference field looks like once it has been included. The
    // object carries no code of its own, so byId is the only map that can
    // resolve it — an object that also held `category: "ECO"` would be resolved
    // by byCode and prove nothing about the id lookup.
    install({
      VehiclesNew: [category],
      FleetNew: [{ _id: 'f-1', plate: 'ABC-1234', model: 'Kia Picanto', category: { _id: ECO_ID, title: 'Economy' } }],
    });
    expect((await snapshot()).fleetVehicles[0]).toMatchObject({
      category: 'ECO', categoryId: ECO_ID, categoryTitle: 'Economy',
    });
  });

  test('a reference object carrying both an id and a code still resolves', async () => {
    install({
      VehiclesNew: [category],
      FleetNew: [{ _id: 'f-1', plate: 'ABC-1234', model: 'Kia Picanto', category: { _id: ECO_ID, category: 'ECO' } }],
    });
    expect((await snapshot()).fleetVehicles[0]).toMatchObject({ category: 'ECO', categoryTitle: 'Economy' });
  });

  test('an unknown code is kept as written rather than blanked', async () => {
    install({ VehiclesNew: [category], FleetNew: [{ _id: 'f-1', plate: 'ABC-1234', model: 'Kia', category: 'VAN' }] });
    expect((await snapshot()).fleetVehicles[0]).toMatchObject({ category: 'VAN', categoryTitle: '' });
  });

  test('a bare id string resolves through the byId map', async () => {
    // The third shape a category reference arrives in, and the one that used to
    // resolve to nothing: a reference field read without being included comes
    // back as the bare record id. The id was only ever taken off an object, so
    // byId was never consulted for it, and the opaque-id guard then blanked the
    // code — the vehicle listed with no category at all, even though the
    // category existed and the map that would resolve it had been built.
    install({
      VehiclesNew: [category],
      FleetNew: [{ _id: 'f-1', plate: 'ABC-1234', model: 'Kia Picanto', category: ECO_ID }],
    });
    const [row] = (await snapshot()).fleetVehicles;
    expect(row).toMatchObject({
      category: 'ECO', categoryId: ECO_ID,
      categoryTitle: 'Economy', categoryDisplayTitle: 'ECO - Economy',
    });
  });

  test('and such a vehicle can now be saved without retyping its category', async () => {
    // The same resolver runs on the way in, so this was the second half of the
    // same fault: the category was blank by the time the guard checked it, and
    // the save was rejected. The row was stuck — it could not be edited at all
    // until someone retyped the code.
    install({
      VehiclesNew: [category],
      FleetNew: [{ _id: 'f-1', plate: 'ABC-1234', model: 'Kia Picanto', category: ECO_ID }],
    });
    const saved = await upsertFleetVehicle({
      authToken: await token(),
      payload: { _id: 'f-1', plate: 'ABC-1234', model: 'Kia Picanto', category: ECO_ID },
    });
    expect(saved).toMatchObject({ category: 'ECO', categoryId: ECO_ID });
  });

  test('the save normalises the id down to the code, as it does for any shape', async () => {
    install({
      VehiclesNew: [category],
      FleetNew: [{ _id: 'f-1', plate: 'ABC-1234', model: 'Kia Picanto', category: ECO_ID }],
    });
    await upsertFleetVehicle({
      authToken: await token(),
      payload: { _id: 'f-1', plate: 'ABC-1234', model: 'Kia Picanto', category: ECO_ID },
    });
    expect(fake.rows('FleetNew')[0].category).toBe('ECO');
  });

  test('an id that matches no category still yields no code, rather than the id', async () => {
    // The opaque-id guard still does its job: an id-shaped value that resolves
    // to nothing must not be shown to an operator as if it were a category code.
    install({
      VehiclesNew: [category],
      FleetNew: [{ _id: 'f-1', plate: 'ABC-1234', model: 'Kia', category: 'deadbeef-0000-1111-2222-333344445555' }],
    });
    expect((await snapshot()).fleetVehicles[0]).toMatchObject({ category: '', categoryTitle: '' });
  });

  test('a short code that happens to be hex is still treated as a code', async () => {
    // The guard keys on length as well as alphabet, so a real code like "ABCDEF"
    // is not mistaken for an id.
    install({
      VehiclesNew: [{ _id: 'v-2', category: 'ABCDEF', title: 'Hexish' }],
      FleetNew: [{ _id: 'f-1', plate: 'ABC-1234', model: 'Kia', category: 'ABCDEF' }],
    });
    expect((await snapshot()).fleetVehicles[0]).toMatchObject({ category: 'ABCDEF', categoryTitle: 'Hexish' });
  });

  test('active vehicles are listed before inactive ones', async () => {
    install({ VehiclesNew: [category], FleetNew: [
      { _id: 'a', plate: 'AAA-1111', model: 'A', category: 'ECO', active: false },
      { _id: 'b', plate: 'BBB-2222', model: 'B', category: 'ECO', active: true },
    ] });
    expect((await snapshot()).fleetVehicles.map((r) => r.plate)).toEqual(['BBB-2222', 'AAA-1111']);
  });

  test('then by plate, then by model', async () => {
    install({ VehiclesNew: [category], FleetNew: [
      { _id: 'b', plate: 'BBB-2222', model: 'B', category: 'ECO' },
      { _id: 'a', plate: 'AAA-1111', model: 'Z', category: 'ECO' },
      { _id: 'c', plate: 'AAA-1111', model: 'A', category: 'ECO' },
    ] });
    expect((await snapshot()).fleetVehicles.map((r) => r.model)).toEqual(['A', 'Z', 'B']);
  });

  test('a vehicle takes a status from its active flag when none is stored', async () => {
    install({ VehiclesNew: [category], FleetNew: [
      { _id: 'a', plate: 'AAA-1111', model: 'A', category: 'ECO', active: true },
      { _id: 'b', plate: 'BBB-2222', model: 'B', category: 'ECO', active: false },
    ] });
    const rows = (await snapshot()).fleetVehicles;
    expect(rows.find((r) => r.plate === 'AAA-1111').status).toBe('available');
    expect(rows.find((r) => r.plate === 'BBB-2222').status).toBe('inactive');
  });

  test('the display title names the plate, model and category together', async () => {
    install({ VehiclesNew: [category], FleetNew: [{ _id: 'f-1', plate: 'ABC-1234', model: 'Kia Picanto', category: 'ECO' }] });
    expect((await snapshot()).fleetVehicles[0].displayTitle).toBe('ABC-1234 - Kia Picanto (ECO - Economy)');
  });

  test('a vehicle with no model is named by its plate alone', async () => {
    install({ VehiclesNew: [category], FleetNew: [{ _id: 'f-1', plate: 'ABC-1234', category: 'ECO' }] });
    expect((await snapshot()).fleetVehicles[0].displayTitle).toBe('ABC-1234 (ECO - Economy)');
  });

  test('the model falls back to the title', async () => {
    install({ VehiclesNew: [category], FleetNew: [{ _id: 'f-1', plate: 'ABC-1234', Title: 'Kia Picanto', category: 'ECO' }] });
    expect((await snapshot()).fleetVehicles[0].model).toBe('Kia Picanto');
  });
});

describe('when a collection is unavailable', () => {
  function breakCollection(name) {
    const original = wixData.query;
    wixData.query = (collection) => {
      if (collection === name) throw new Error(`${name} is offline`);
      return original(collection);
    };
    return () => { wixData.query = original; };
  }

  test('a missing fleet collection empties that panel rather than breaking the page', async () => {
    // queryAllRows swallows per collection, so one broken CMS collection does
    // not take the whole pricing screen down.
    install({ VehiclesNew: [{ _id: 'v-1', category: 'ECO', title: 'Economy' }] });
    const restore = breakCollection('FleetNew');
    try {
      const res = await snapshot();
      expect(res.fleetVehicles).toEqual([]);
      expect(res.vehicleCategories).toHaveLength(1);
      expect(res.businessSettings).toBeTruthy();
    } finally {
      restore();
    }
  });

  test('a first read that fails is retried through the catalogue reader', async () => {
    // This is what the `if (!rows.length)` branch is actually for. The two
    // reads are not identical: queryAllRows asks for included reference fields
    // and passes suppressHooks, the catalogue reader does neither. So a read
    // that fails for either of those reasons is recovered by the retry, which
    // an empty-collection test cannot show — both reads come back empty there.
    install({ VehiclesNew: [{ _id: 'v-1', category: 'ECO', title: 'Economy' }] });
    const originalQuery = wixData.query;
    wixData.query = (collection) => {
      const builder = originalQuery(collection);
      if (collection !== 'VehiclesNew') return builder;
      const realFind = builder.find.bind(builder);
      builder.find = (options) => (options?.suppressHooks
        ? Promise.reject(new Error('hooks unavailable on VehiclesNew'))
        : realFind(options));
      return builder;
    };
    try {
      expect((await snapshot()).vehicleCategories).toHaveLength(1);
    } finally {
      wixData.query = originalQuery;
    }
  });

  test('a broken categories collection empties that panel too', async () => {
    // Both reads go to VehiclesNew, so a collection that is down defeats the
    // retry as well — the panel is empty rather than the page being broken,
    // which is the guarantee that actually holds here.
    install({ VehiclesNew: [{ _id: 'v-1', category: 'ECO', title: 'Economy' }] });
    const restore = breakCollection('VehiclesNew');
    try {
      const res = await snapshot();
      expect(res.vehicleCategories).toEqual([]);
      expect(res.businessSettings).toBeTruthy();
      expect(res.insurancePlans.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });
});

describe('the two smaller exports', () => {
  test('exportPricingCatalogSnapshot returns the catalogue without the admin lists', async () => {
    install({ FleetNew: [{ _id: 'f-1', plate: 'ABC-1234', model: 'Kia', category: 'ECO' }] });
    const res = await exportPricingCatalogSnapshot({ authToken: await token() });

    expect(res.businessSettings).toBeTruthy();
    expect(res.insurancePlans.length).toBeGreaterThan(0);
    expect(res.fleetVehicles).toBeUndefined();
    expect(res.vehicleCategories).toBeUndefined();
  });

  test('it is forced too, so an export is never a stale copy', async () => {
    install();
    await exportPricingCatalogSnapshot({ authToken: await token() });
    await wixData.insert('InsurancePlans', { _id: 'i-2', key: 'housecover', label: 'House cover', pricePerDay: 20 }, { suppressAuth: true });

    const res = await exportPricingCatalogSnapshot({ authToken: await token() });
    expect(res.insurancePlans.map((p) => p.key)).toContain('housecover');
  });

  test('getStaffPricingCatalog serves the cached catalogue instead of forcing', async () => {
    // The difference is deliberate: this one backs a read-only staff view, so
    // it takes the cheap copy where the admin screen pays for a fresh read.
    install();
    await getStaffPricingCatalog({ authToken: await token() });
    await wixData.insert('InsurancePlans', { _id: 'i-2', key: 'housecover', label: 'House cover', pricePerDay: 20 }, { suppressAuth: true });

    const res = await getStaffPricingCatalog({ authToken: await token() });
    expect(res.insurancePlans.map((p) => p.key)).not.toContain('housecover');
  });

  test('and it shows internal rows, not just the public ones', async () => {
    install({ PickupLocations: [{ _id: 'p-1', key: 'depot', label: 'Depot', publicVisible: false }] });
    const res = await getStaffPricingCatalog({ authToken: await token() });
    expect(res.pickupLocations.map((p) => p.key)).toContain('depot');
  });
});

describe('the pickup location list', () => {
  const location = (extra = {}) => ({
    key: 'ath', label: 'Athens Airport', address: 'Athens Airport', active: true, ...extra,
  });

  test('locations are listed in their configured order', async () => {
    install({
      PickupLocations: [
        { _id: 'p-3', key: 'c', label: 'Third', address: 'C', sortOrder: 30 },
        { _id: 'p-1', key: 'a', label: 'First', address: 'A', sortOrder: 10 },
        { _id: 'p-2', key: 'b', label: 'Second', address: 'B', sortOrder: 20 },
      ],
    });

    const rows = (await snapshot()).pickupLocations;

    expect(rows.map((r) => r.label)).toEqual(['First', 'Second', 'Third']);
  });

  test('locations sharing an order fall back to their display title', async () => {
    install({
      PickupLocations: [
        { _id: 'p-2', key: 'b', label: 'Beta', address: 'B', sortOrder: 10 },
        { _id: 'p-1', key: 'a', label: 'Alpha', address: 'A', sortOrder: 10 },
      ],
    });

    const rows = (await snapshot()).pickupLocations;

    expect(rows.map((r) => r.label)).toEqual(['Alpha', 'Beta']);
  });

  test('a location with no order sinks to the bottom rather than to the top', async () => {
    install({
      PickupLocations: [
        { _id: 'p-1', key: 'a', label: 'Unordered', address: 'A' },
        { _id: 'p-2', key: 'b', label: 'Ordered', address: 'B', sortOrder: 10 },
      ],
    });

    const rows = (await snapshot()).pickupLocations;

    expect(rows.map((r) => r.label)).toEqual(['Ordered', 'Unordered']);
  });

  test('a location with no label of its own is titled "Location", not by its address', async () => {
    // The display title reads `label || address || key || 'Location'`, but only
    // the first term is ever reached: normalizePickupLocationItem has already
    // defaulted a missing label to the literal 'Location'. Pinned as it behaves
    // — the three fallbacks behind it are dead, which is worth knowing before
    // anyone relies on a location being titled by its address.
    install({
      PickupLocations: [
        { _id: 'p-1', key: 'ath', label: 'Athens Airport', address: 'Somewhere' },
        { _id: 'p-2', key: 'skg', label: '', address: 'Thessaloniki Port' },
      ],
    });

    const byKey = Object.fromEntries((await snapshot()).pickupLocations.map((r) => [r.key, r.displayTitle]));

    expect(byKey).toMatchObject({ ath: 'Athens Airport', skg: 'Location' });
  });

  test('a saved location appears in the next snapshot', async () => {
    install();

    await upsertPickupLocation({ authToken: await token(), payload: location() });

    expect((await snapshot()).pickupLocations.map((r) => r.key)).toContain('ath');
  });
});

describe('saving the business settings for the first time', () => {
  // Every other test in the pricing suites starts from a site that already has
  // a settings row, so the insert half of this endpoint has never run.
  test('a site with no settings row gets one created', async () => {
    install({ BusinessSettings: [] });

    const saved = await saveBusinessSettings({
      authToken: await token(), payload: { currency: 'USD', nightStartHour: 23 },
    });

    expect(saved._id).toBeTruthy();
    expect(fake.rows('BusinessSettings')).toHaveLength(1);
    expect(fake.rows('BusinessSettings')[0]).toMatchObject({ currency: 'USD' });
  });

  test('saving again updates that row rather than adding another', async () => {
    install({ BusinessSettings: [] });
    const authToken = await token();

    await saveBusinessSettings({ authToken, payload: { currency: 'USD' } });
    await saveBusinessSettings({ authToken, payload: { currency: 'GBP' } });

    expect(fake.rows('BusinessSettings')).toHaveLength(1);
    expect(fake.rows('BusinessSettings')[0].currency).toBe('GBP');
  });

  test('the first save is written to the audit log like any other', async () => {
    install({ BusinessSettings: [] });

    await saveBusinessSettings({ authToken: await token(), payload: { currency: 'USD' } });

    // Written to StaffAuditLog, which is where every pricing action is logged —
    // PricingAuditLog exists in the seeds but nothing writes to it.
    expect(fake.rows('StaffAuditLog').some((r) => r.action === 'pricing.saveBusinessSettings')).toBe(true);
  });
});

describe('the station profiles carried on the business settings', () => {
  const save = async (payload) => {
    install();
    return saveBusinessSettings({ authToken: await token(), payload });
  };

  test('a station list is normalised into keyed profiles', async () => {
    const saved = await save({
      stationProfiles: [
        { key: 'ATH', label: 'Athens Airport', city: 'Athens', address: 'Airport', sortOrder: 10 },
      ],
    });

    expect(saved.stationProfiles).toEqual([{
      key: 'ath', label: 'Athens Airport', description: '', city: 'Athens',
      address: 'Airport', sortOrder: 10, active: true,
    }]);
  });

  test('the legacy field names are accepted', async () => {
    const saved = await save({
      stationProfiles: [{ stationKey: 'SKG', stationLabel: 'Port', stationCity: 'Thessaloniki', stationAddress: 'Quay 1' }],
    });

    expect(saved.stationProfiles[0]).toMatchObject({
      key: 'skg', label: 'Port', city: 'Thessaloniki', address: 'Quay 1',
    });
  });

  test('a station with no key or label at all is filed under "default"', async () => {
    const saved = await save({ stationProfiles: [{ city: 'Athens' }] });

    expect(saved.stationProfiles[0]).toMatchObject({ key: 'default', label: 'Κεντρικός σταθμός' });
  });

  test('a duplicate key keeps the first entry rather than the last', async () => {
    // The list is what the admin screen renders; two rows with one key would
    // render twice and save inconsistently.
    const saved = await save({
      stationProfiles: [
        { key: 'ath', label: 'Athens Airport' },
        { key: 'ATH', label: 'Athens Airport (duplicate)' },
      ],
    });

    expect(saved.stationProfiles).toHaveLength(1);
    expect(saved.stationProfiles[0].label).toBe('Athens Airport');
  });

  test('an inactive station is kept in the list, flagged', async () => {
    const saved = await save({ stationProfiles: [{ key: 'skg', label: 'Port', active: false }] });

    expect(saved.stationProfiles[0]).toMatchObject({ key: 'skg', active: false });
  });

  test.each([
    ['a string', 'ATH'],
    ['null', null],
    ['a number', 7],
    ['nothing at all', undefined],
  ])('a station list sent as %s leaves the single default station standing', async (_label, stationProfiles) => {
    // Two copies of normalizeStationProfiles exist — one in pricingAdmin, one in
    // pricingCatalog — and they disagree about the empty case. The admin copy
    // returns an empty list; the catalog copy, which is what seeds and reads the
    // settings row, appends a default station when the list comes out empty. So
    // a site never ends up with *no* station, whatever the admin screen sends.
    // Pinned as it behaves; the divergence is worth knowing before either copy
    // is edited on the assumption it is the only one.
    const saved = await save(stationProfiles === undefined ? {} : { stationProfiles });

    expect(saved.stationProfiles).toEqual([
      { key: 'default', label: 'Κεντρικός σταθμός', description: '' },
    ]);
  });

  test('the per-station settings map is keyed the same way as the profiles', async () => {
    const saved = await save({
      stationSettings: { 'ATH': { openingHours: '08:00-22:00' }, 'SKG Port': { openingHours: '09:00-21:00' } },
    });

    expect(Object.keys(saved.stationSettings).sort()).toEqual(['ath', 'skg_port']);
    expect(saved.stationSettings.ath).toEqual({ openingHours: '08:00-22:00' });
  });

  test('a settings entry that is not an object is dropped', async () => {
    const saved = await save({
      stationSettings: { ath: { openingHours: '08:00-22:00' }, skg: 'closed', port: ['a'], hotel: null },
    });

    expect(Object.keys(saved.stationSettings)).toEqual(['ath']);
  });

  test('a settings map that is not an object at all becomes an empty one', async () => {
    expect((await save({ stationSettings: ['ath'] })).stationSettings).toEqual({});
    expect((await save({ stationSettings: 'ath' })).stationSettings).toEqual({});
    expect((await save({})).stationSettings).toEqual({});
  });

  test('an entry with no usable key is filed under "default"', async () => {
    const saved = await save({ stationSettings: { '   ': { openingHours: '24h' } } });

    expect(saved.stationSettings).toEqual({ default: { openingHours: '24h' } });
  });
});
