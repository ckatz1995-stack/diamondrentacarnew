import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import {
  getPricingAdminSnapshot,
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

  test('an explicit sortOrder of 0 sorts LAST, not first', async () => {
    // Surprising, and the reason the `|| 9999` in the comparator is not dead
    // code: the normaliser has already defaulted a missing sortOrder to 9999,
    // so the only value that `||` still rewrites is a real, deliberate 0 — and
    // it rewrites it to 9999. An operator typing 0 to mean "show this first"
    // gets the opposite.
    install({ VehiclesNew: [
      { _id: 'a', category: 'AAA', title: 'Alpha', sortOrder: 0 },
      { _id: 'b', category: 'ZZZ', title: 'Zulu', sortOrder: 10 },
    ] });
    expect((await snapshot()).vehicleCategories.map((r) => r.category)).toEqual(['ZZZ', 'AAA']);
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

  test('a bare id string does NOT resolve — the category comes back blank', async () => {
    // FINDING, pinned as current behaviour rather than fixed.
    //
    // categoryLookupMaps builds a byId map, and resolveFleetCategoryMeta reads
    // it — but the id it looks up is only ever taken from an *object* value. A
    // category held as a plain string that happens to be a record id therefore
    // never reaches byId, and the opaque-id guard then blanks the code because
    // it looks like an id rather than something a person typed.
    //
    // Net effect: the vehicle is listed with no category at all, even though
    // the category exists and the map that would resolve it was built.
    install({
      VehiclesNew: [category],
      FleetNew: [{ _id: 'f-1', plate: 'ABC-1234', model: 'Kia Picanto', category: ECO_ID }],
    });
    const [row] = (await snapshot()).fleetVehicles;
    expect(row).toMatchObject({ category: '', categoryId: '', categoryTitle: '', categoryDisplayTitle: '' });
  });

  test('and such a vehicle cannot be saved from the admin screen at all', async () => {
    // The same resolver runs on the way in, so the category is blank by the
    // time the guard checks it — and the guard rejects the save. A row in this
    // state cannot be edited and re-saved without retyping the category.
    install({
      VehiclesNew: [category],
      FleetNew: [{ _id: 'f-1', plate: 'ABC-1234', model: 'Kia Picanto', category: ECO_ID }],
    });
    await expect(upsertFleetVehicle({
      authToken: await token(),
      payload: { _id: 'f-1', plate: 'ABC-1234', model: 'Kia Picanto', category: ECO_ID },
    })).rejects.toThrow('Missing fleet category');
  });

  test('retyping the code saves it, which is the only way out today', async () => {
    install({
      VehiclesNew: [category],
      FleetNew: [{ _id: 'f-1', plate: 'ABC-1234', model: 'Kia Picanto', category: ECO_ID }],
    });
    const saved = await upsertFleetVehicle({
      authToken: await token(),
      payload: { _id: 'f-1', plate: 'ABC-1234', model: 'Kia Picanto', category: 'ECO' },
    });
    expect(saved.category).toBe('ECO');
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
