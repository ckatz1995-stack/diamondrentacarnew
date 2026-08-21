import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import {
  deletePricingItem, deletePricingSeason, deleteCategoryRateRule, deletePickupLocation,
} from '../pricingAdmin.jsw';
import { PRICING_COLLECTIONS, getPricingCatalog, clearPricingCatalogCache } from '../pricingCatalog.jsw';

// The one pricing endpoint that removes rows, and the only public function in the
// module that takes a collection name from its caller. That is what makes the
// allowlist here load-bearing rather than decorative: without it this is a
// "delete anything by name" endpoint, which is exactly the reason upsertByKey was
// taken off the browser-callable surface.
//
// It also does a second thing that is easy to miss — after removing the row it
// was given, it hunts down every other row sharing the same normalised key and
// removes those too. That is deliberate (duplicate keys are what upsertByKey
// cleans up on write) but it means one delete can take several rows, so the
// count it reports has to be true.

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
    // Seeded non-empty so ensurePricingSeeded leaves them alone.
    BusinessSettings: [{ _id: 'bs-1', currency: 'EUR' }],
    InsurancePlans: [{ _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 10 }],
    ExtraServices: [{ _id: 'x-1', key: 'gps', label: 'GPS', price: 5 }],
    FeeRules: [{ _id: 'f-1', key: 'night', label: 'Night', amount: 15 }],
    PricingSeasons: [],
    CategoryRateRules: [],
    PickupLocations: [],
    ...extra,
  };
}

let fake;
function install(extra) {
  clearPricingCatalogCache();
  fake = createFakeWixData(seed(extra)).install(wixData);
  return fake;
}

async function token() {
  const { sessionToken } = await loginStaff({ email: EMAIL, password: PASSWORD });
  return sessionToken;
}

const del = async (args) => deletePricingItem({ authToken: await token(), ...args });
const plans = () => fake.rows('InsurancePlans');

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
  clearPricingCatalogCache();
});

describe('the collection allowlist', () => {
  // Named individually rather than looped over the object, so adding a
  // collection to PRICING_COLLECTIONS without thinking about deletion shows up
  // here as a gap rather than being swept along by a loop.
  test.each([
    ['BusinessSettings'],
    ['InsurancePlans'],
    ['ExtraServices'],
    ['FeeRules'],
    ['PricingSeasons'],
    ['CategoryRateRules'],
    ['PickupLocations'],
  ])('%s is allowed', async (collectionName) => {
    install();
    await expect(del({ collectionName, itemId: 'nothing-here' })).resolves.toMatchObject({ success: true });
  });

  test('the allowlist is exactly the pricing collections, no more', async () => {
    expect(new Set(Object.values(PRICING_COLLECTIONS))).toEqual(new Set([
      'BusinessSettings', 'InsurancePlans', 'ExtraServices', 'FeeRules',
      'PricingSeasons', 'CategoryRateRules', 'PickupLocations',
    ]));
  });

  test.each([
    ['StaffUsers'],
    ['StaffCredentials'],
    ['StaffSessions'],
    ['StaffRoles'],
    ['BookingsNew'],
    ['RentalsNew'],
    ['FleetNew'],
    ['VehiclesNew'],
  ])('%s is refused', async (collectionName) => {
    // The endpoint takes a collection name from its caller, so this list is the
    // whole of what stops it deleting staff credentials or bookings.
    install();
    await expect(del({ collectionName, itemId: 'anything' })).rejects.toThrow('Collection not allowed');
  });

  test('a refused collection is not touched at all', async () => {
    install();
    await del({ collectionName: 'StaffCredentials', itemId: 'cred-1' }).catch(() => {});
    expect(fake.rows('StaffCredentials')).toHaveLength(1);
    expect(fake.calls.remove).toHaveLength(0);
  });

  test('a name that merely resembles an allowed one is refused', async () => {
    install();
    for (const name of ['insuranceplans', 'InsurancePlans ', 'InsurancePlan', 'InsurancePlansBackup']) {
      await expect(del({ collectionName: name, itemId: 'plan-1' })).rejects.toThrow('Collection not allowed');
    }
    expect(plans()).toHaveLength(1);
  });
});

describe('what it needs to be told', () => {
  test('refuses a call with no collection', async () => {
    install();
    await expect(del({ itemId: 'plan-1' })).rejects.toThrow(/Missing collectionName/);
  });

  test('refuses a call with neither an id nor a key', async () => {
    install();
    await expect(del({ collectionName: 'InsurancePlans' })).rejects.toThrow(/Missing collectionName/);
  });

  test('accepts an id on its own', async () => {
    install();
    await expect(del({ collectionName: 'InsurancePlans', itemId: 'plan-1' })).resolves.toMatchObject({ success: true });
  });

  test('accepts a key on its own', async () => {
    install();
    await expect(del({ collectionName: 'InsurancePlans', itemKey: 'cdw' })).resolves.toMatchObject({ success: true });
  });

  test('refuses an unauthenticated caller, and removes nothing', async () => {
    install();
    await expect(deletePricingItem({ collectionName: 'InsurancePlans', itemId: 'plan-1' }))
      .rejects.toThrow('AUTH_REQUIRED');
    expect(plans()).toHaveLength(1);
    expect(fake.calls.remove).toHaveLength(0);
  });
});

describe('removing a row', () => {
  test('takes the row out and says so', async () => {
    install();
    const result = await del({ collectionName: 'InsurancePlans', itemId: 'plan-1' });
    expect(result).toEqual({ success: true, removed: 1 });
    expect(plans()).toHaveLength(0);
  });

  test('passes suppressAuth as the options argument', async () => {
    install();
    await del({ collectionName: 'InsurancePlans', itemId: 'plan-1' });
    const [call] = fake.calls.remove.filter((c) => c.collection === 'InsurancePlans');
    expect(call.options).toEqual({ suppressAuth: true });
  });

  test('leaves the other rows alone', async () => {
    install({
      InsurancePlans: [
        { _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 10 },
        { _id: 'plan-2', key: 'scdw', label: 'Super CDW', pricePerDay: 20 },
      ],
    });
    await del({ collectionName: 'InsurancePlans', itemId: 'plan-1' });
    expect(plans().map((p) => p.key)).toEqual(['scdw']);
  });

  test('an id that matches nothing removes nothing and does not throw', async () => {
    install();
    const result = await del({ collectionName: 'InsurancePlans', itemId: 'no-such-row' });
    expect(result.success).toBe(true);
    expect(plans()).toHaveLength(1);
  });

  test('the next catalogue read sees the change rather than a cached price', async () => {
    // The cache is cleared on the way out; without that the old price would keep
    // being quoted for up to a minute after the delete.
    install({ InsurancePlans: [{ _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 35, active: true, publicVisible: true }] });
    expect((await getPricingCatalog()).maps.insurance.cdw).toBe(35);

    await del({ collectionName: 'InsurancePlans', itemId: 'plan-1' });

    expect((await getPricingCatalog()).maps.insurance.cdw).not.toBe(35);
  });

  test('deleting a row whose key has a built-in default really removes it', async () => {
    // This used to be the other way round. The catalogue readers merged the
    // shipped fallback options with the stored rows key by key, so a key that
    // existed in both survived its own deletion — at the fallback's price, which
    // for cdw is 0. A plan an operator had priced at 35 came back free.
    install({ InsurancePlans: [
      { _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 35, active: true, publicVisible: true },
      { _id: 'plan-2', key: 'scdw', label: 'Super CDW', pricePerDay: 20, active: true, publicVisible: true },
    ] });

    await del({ collectionName: 'InsurancePlans', itemId: 'plan-1' });

    const catalog = await getPricingCatalog({ scope: 'public' });
    expect(catalog.insurancePlans.map((p) => p.key)).not.toContain('cdw');
    expect(catalog.insurancePlans.map((p) => p.key)).toContain('scdw');
  });

  test('but emptying the collection entirely restores the shipped set', async () => {
    // The remaining edge, and it is deliberate rather than a leftover: an empty
    // collection means "not configured", and ensurePricingSeeded writes the
    // shipped rows back into it on the next admin load. Deleting the last row is
    // therefore a reset, not a removal. Anything short of that is a removal.
    install({ InsurancePlans: [{ _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 35, active: true, publicVisible: true }] });

    await del({ collectionName: 'InsurancePlans', itemId: 'plan-1' });

    expect(fake.rows('InsurancePlans')).toHaveLength(0);
    const catalog = await getPricingCatalog({ scope: 'public' });
    expect(catalog.insurancePlans.map((p) => p.key)).toContain('cdw');
    expect(catalog.maps.insurance.cdw).toBe(0);
  });

  test('a row whose key has no built-in default really does go', async () => {
    // The other half: deletion works as expected for anything the site added.
    install({
      InsurancePlans: [
        { _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 35, active: true, publicVisible: true },
        { _id: 'plan-house', key: 'housecover', label: 'House cover', pricePerDay: 40, active: true, publicVisible: true },
      ],
    });
    await del({ collectionName: 'InsurancePlans', itemId: 'plan-house' });

    const catalog = await getPricingCatalog({ scope: 'public' });
    expect(catalog.insurancePlans.map((p) => p.key)).not.toContain('housecover');
  });
});

describe('the duplicates it takes with it', () => {
  const withDuplicates = () => ({
    InsurancePlans: [
      { _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 10 },
      { _id: 'plan-dupe', key: 'cdw', label: 'CDW (old)', pricePerDay: 99 },
      { _id: 'plan-keep', key: 'scdw', label: 'Super CDW', pricePerDay: 20 },
    ],
  });

  test('rows sharing the key go too', async () => {
    install(withDuplicates());
    const result = await del({ collectionName: 'InsurancePlans', itemId: 'plan-1' });
    expect(result.removed).toBe(2);
    expect(plans().map((p) => p._id)).toEqual(['plan-keep']);
  });

  test('a row with a different key stays', async () => {
    install(withDuplicates());
    await del({ collectionName: 'InsurancePlans', itemId: 'plan-1' });
    expect(plans().map((p) => p.key)).toEqual(['scdw']);
  });

  test('the key is taken from the row when the caller gives only an id', async () => {
    install(withDuplicates());
    const result = await del({ collectionName: 'InsurancePlans', itemId: 'plan-1' });
    expect(result.removed).toBe(2);
  });

  test('a key given by the caller wins over the row\'s own', async () => {
    install(withDuplicates());
    const result = await del({ collectionName: 'InsurancePlans', itemId: 'plan-keep', itemKey: 'cdw' });
    // plan-keep by id, and both cdw rows by key.
    expect(result.removed).toBe(3);
    expect(plans()).toHaveLength(0);
  });

  test('deleting by key alone takes every row with that key', async () => {
    install(withDuplicates());
    const result = await del({ collectionName: 'InsurancePlans', itemKey: 'cdw' });
    expect(result.removed).toBe(2);
    expect(plans().map((p) => p._id)).toEqual(['plan-keep']);
  });

  test('keys are matched after normalisation, not literally', async () => {
    // upsertByKey slugs the key on the way in, so rows written at different
    // times can carry different spellings of the same thing.
    install({
      InsurancePlans: [
        { _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 10 },
        { _id: 'plan-2', key: 'CDW', label: 'CDW upper', pricePerDay: 11 },
      ],
    });
    const result = await del({ collectionName: 'InsurancePlans', itemId: 'plan-1' });
    expect(result.removed).toBe(2);
    expect(plans()).toHaveLength(0);
  });

  test('the row named by id is never double-counted', async () => {
    install();
    const result = await del({ collectionName: 'InsurancePlans', itemId: 'plan-1', itemKey: 'cdw' });
    expect(result.removed).toBe(1);
  });
});

describe('the trail it leaves', () => {
  test('a delete is written to the audit log against the caller', async () => {
    install();
    await del({ collectionName: 'InsurancePlans', itemId: 'plan-1' });
    const entry = fake.rows('StaffAuditLog').find((e) => e.action === 'pricing.delete');
    expect(entry).toMatchObject({ actorEmail: EMAIL, entityType: 'pricing.InsurancePlans' });
  });

  test('the entry keeps what was deleted, since the row itself is gone', async () => {
    install();
    await del({ collectionName: 'InsurancePlans', itemId: 'plan-1' });
    const entry = fake.rows('StaffAuditLog').find((e) => e.action === 'pricing.delete');
    expect(entry.oldValue).toContain('CDW');
    expect(entry.newValue).toBe('');
  });

  test('the summary says how many rows went', async () => {
    install({
      InsurancePlans: [
        { _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 10 },
        { _id: 'plan-dupe', key: 'cdw', label: 'CDW (old)', pricePerDay: 99 },
      ],
    });
    await del({ collectionName: 'InsurancePlans', itemId: 'plan-1' });
    const entry = fake.rows('StaffAuditLog').find((e) => e.action === 'pricing.delete');
    expect(entry.summary).toContain('2');
  });
});

describe('the wrappers that name their own collection', () => {
  // These are the functions the admin screen actually calls. They exist so a
  // caller never has to pass a collection name, which is the safer shape.
  test('deletePricingSeason removes from PricingSeasons only', async () => {
    install({ PricingSeasons: [{ _id: 's-1', key: 'summer', label: 'Summer' }] });
    const result = await deletePricingSeason({ authToken: await token(), itemId: 's-1' });
    expect(result).toMatchObject({ success: true, removed: 1 });
    expect(fake.rows('PricingSeasons')).toHaveLength(0);
    expect(plans()).toHaveLength(1);
  });

  test('deleteCategoryRateRule removes from CategoryRateRules only', async () => {
    install({ CategoryRateRules: [{ _id: 'r-1', key: 'eco-1', label: 'ECO' }] });
    const result = await deleteCategoryRateRule({ authToken: await token(), itemId: 'r-1' });
    expect(result).toMatchObject({ success: true, removed: 1 });
    expect(fake.rows('CategoryRateRules')).toHaveLength(0);
  });

  test('deletePickupLocation removes from PickupLocations only', async () => {
    install({ PickupLocations: [{ _id: 'l-1', key: 'airport', label: 'Airport' }] });
    const result = await deletePickupLocation({ authToken: await token(), itemId: 'l-1' });
    expect(result).toMatchObject({ success: true, removed: 1 });
    expect(fake.rows('PickupLocations')).toHaveLength(0);
  });

  test.each([
    ['deletePricingSeason', deletePricingSeason],
    ['deleteCategoryRateRule', deleteCategoryRateRule],
    ['deletePickupLocation', deletePickupLocation],
  ])('%s refuses an unauthenticated caller', async (_label, fn) => {
    install();
    await expect(fn({ itemId: 'anything' })).rejects.toThrow('AUTH_REQUIRED');
  });
});
