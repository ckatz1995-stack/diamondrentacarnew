import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import {
  getPricingCatalog,
  resolveDynamicPricingRate,
  getPublicPricingCatalog,
  getPricingMaps,
  clearPricingCatalogCache,
  PRICING_COLLECTIONS,
} from '../pricingCatalog.jsw';

// How CMS rows become the pricing catalogue every quote is built from.
//
// pricingCatalog.test.js covers the calculators that read the catalogue —
// resolveDynamicPricingRate, computeAutomaticFees, the season matcher. This
// covers the layer underneath: the normalisers that turn a stored row into a
// rule, the scope filter that decides what the public site may see, the merge
// that lets shipped defaults and CMS rows coexist, and the cache that sits in
// front of all of it.
//
// Three of those normalisers — seasons, category rate rules and pickup
// locations — had never run: no test seeded those collections, so every row
// that reached them was hypothetical.

const SEASONS = PRICING_COLLECTIONS.pricingSeasons;
const RATES = PRICING_COLLECTIONS.categoryRateRules;

function seed(extra = {}) {
  return {
    BusinessSettings: [{ _id: 'bs-1', currency: 'EUR' }],
    InsurancePlans: [],
    ExtraServices: [],
    FeeRules: [],
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
/** Always force: the cache is the subject of its own describe block, not a hazard for the rest. */
const catalog = (scope = 'all') => getPricingCatalog({ scope, force: true });

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
  clearPricingCatalogCache();
});

describe('pricing seasons', () => {
  const season = (extra = {}) => ({ _id: 's-1', label: 'Summer', startDate: '2026-06-01', endDate: '2026-09-15', ...extra });

  test('a stored row becomes a season with its dates intact', async () => {
    install({ PricingSeasons: [season({ key: 'summer' })] });
    const [row] = (await catalog()).pricingSeasons;
    expect(row).toMatchObject({
      _id: 's-1', key: 'summer', label: 'Summer',
      startDate: '2026-06-01', endDate: '2026-09-15',
    });
  });

  test('the key is derived from the label when none is stored', async () => {
    install({ PricingSeasons: [season({ label: 'High Season 2026' })] });
    expect((await catalog()).pricingSeasons[0].key).toBe('high_season_2026');
  });

  test('and from the dates themselves when there is no label either', async () => {
    // The last resort, so two undated rows cannot collide into one key.
    install({ PricingSeasons: [{ _id: 's-1', title: '', startDate: '2026-06-01', endDate: '2026-09-15' }] });
    expect((await catalog()).pricingSeasons[0].key).toBe('2026_06_01_2026_09_15');
  });

  test('the date fields are read under any of their three spellings', async () => {
    install({ PricingSeasons: [
      { _id: 'a', label: 'A', startDate: '2026-01-01', endDate: '2026-01-31' },
      { _id: 'b', label: 'B', start: '2026-02-01', end: '2026-02-28' },
      { _id: 'c', label: 'C', fromDate: '2026-03-01', toDate: '2026-03-31' },
    ] });
    const rows = (await catalog()).pricingSeasons;
    expect(rows.map((r) => [r.startDate, r.endDate])).toEqual([
      ['2026-01-01', '2026-01-31'],
      ['2026-02-01', '2026-02-28'],
      ['2026-03-01', '2026-03-31'],
    ]);
  });

  test('priority and repeatYearly default to nothing special', async () => {
    install({ PricingSeasons: [season({ key: 'summer' })] });
    expect((await catalog()).pricingSeasons[0]).toMatchObject({ priority: 0, repeatYearly: false });
  });

  test('repeatYearly accepts the string a CMS checkbox stores', async () => {
    install({ PricingSeasons: [season({ key: 'summer', repeatYearly: 'true', priority: '5' })] });
    expect((await catalog()).pricingSeasons[0]).toMatchObject({ repeatYearly: true, priority: 5 });
  });

  test('an inactive season is left out entirely', async () => {
    install({ PricingSeasons: [season({ key: 'summer', active: false })] });
    expect((await catalog()).pricingSeasons).toEqual([]);
  });

  test('a season is keyed in the map by its normalised key', async () => {
    install({ PricingSeasons: [season({ key: 'Summer 2026!' })] });
    const snapshot = await catalog();
    expect(Object.keys(snapshot.maps.pricingSeasons)).toEqual(['summer_2026']);
  });

  test('seasons are ordered by sortOrder, then by label', async () => {
    install({ PricingSeasons: [
      season({ _id: 'c', key: 'c', label: 'Charlie', sortOrder: 20 }),
      season({ _id: 'b', key: 'b', label: 'Bravo', sortOrder: 10 }),
      season({ _id: 'a', key: 'a', label: 'Alpha', sortOrder: 10 }),
    ] });
    expect((await catalog()).pricingSeasons.map((r) => r.label)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });
});

describe('category rate rules', () => {
  const rule = (extra = {}) => ({ _id: 'r-1', label: 'ECO summer', categoryCode: 'eco', pricePerDay: 45, ...extra });

  test('a stored row becomes a rule, with the category upper-cased', async () => {
    install({ CategoryRateRules: [rule({ key: 'eco_summer' })] });
    expect((await catalog()).categoryRateRules[0]).toMatchObject({
      _id: 'r-1', key: 'eco_summer', categoryCode: 'ECO', pricePerDay: 45,
    });
  });

  test('the category is read under any of its three spellings', async () => {
    install({ CategoryRateRules: [
      { _id: 'a', label: 'A', categoryCode: 'eco', pricePerDay: 1 },
      { _id: 'b', label: 'B', category: 'cmp', pricePerDay: 1 },
      { _id: 'c', label: 'C', Category: 'suv', pricePerDay: 1 },
    ] });
    expect((await catalog()).categoryRateRules.map((r) => r.categoryCode)).toEqual(['ECO', 'CMP', 'SUV']);
  });

  test('the price is read under any of its three spellings', async () => {
    install({ CategoryRateRules: [
      { _id: 'a', label: 'A', categoryCode: 'ECO', pricePerDay: 45 },
      { _id: 'b', label: 'B', categoryCode: 'ECO', dailyPrice: 55 },
      { _id: 'c', label: 'C', categoryCode: 'ECO', price: 65 },
    ] });
    expect((await catalog()).categoryRateRules.map((r) => r.pricePerDay)).toEqual([45, 55, 65]);
  });

  test('a zero price is kept rather than treated as missing', async () => {
    // `??` not `||`: a genuinely free category is a legitimate rule.
    install({ CategoryRateRules: [rule({ key: 'free', pricePerDay: 0, price: 99 })] });
    expect((await catalog()).categoryRateRules[0].pricePerDay).toBe(0);
  });

  test('the season key is normalised so it can be matched against a season', async () => {
    install({ CategoryRateRules: [rule({ key: 'r', seasonKey: 'Summer 2026!' })] });
    expect((await catalog()).categoryRateRules[0].seasonKey).toBe('summer_2026');
  });

  test('a day range is floored to whole days', async () => {
    install({ CategoryRateRules: [rule({ key: 'r', minDays: 3.7, maxDays: 9.9 })] });
    expect((await catalog()).categoryRateRules[0]).toMatchObject({ minDays: 3, maxDays: 9 });
  });

  test('minDays is never below one, so a rule always covers at least a day', async () => {
    install({ CategoryRateRules: [rule({ key: 'r', minDays: 0 })] });
    expect((await catalog()).categoryRateRules[0].minDays).toBe(1);
  });

  test('a negative minDays is raised the same way', async () => {
    install({ CategoryRateRules: [rule({ key: 'r', minDays: -5 })] });
    expect((await catalog()).categoryRateRules[0].minDays).toBe(1);
  });

  test('maxDays of zero survives, and means no upper bound', async () => {
    // Unlike minDays, zero is the meaningful default here rather than a floor
    // to correct — the rate-resolver reads 0 as open-ended.
    install({ CategoryRateRules: [rule({ key: 'r' })] });
    expect((await catalog()).categoryRateRules[0].maxDays).toBe(0);
  });

  test('a negative maxDays is clamped to the open-ended zero', async () => {
    install({ CategoryRateRules: [rule({ key: 'r', maxDays: -3 })] });
    expect((await catalog()).categoryRateRules[0].maxDays).toBe(0);
  });

  test('the key falls back to a composite of what makes the rule distinct', async () => {
    install({ CategoryRateRules: [{
      _id: 'r-1', label: '', title: '', categoryCode: 'ECO', seasonKey: 'summer', minDays: 3, maxDays: 7, pricePerDay: 45,
    }] });
    expect((await catalog()).categoryRateRules[0].key).toBe('eco_summer_3_7');
  });

  test('an inactive rule is left out', async () => {
    install({ CategoryRateRules: [rule({ key: 'r', active: false })] });
    expect((await catalog()).categoryRateRules).toEqual([]);
  });

  test('the rules are carried into the maps as a list, not keyed', async () => {
    // Several rules can share a category, so keying them would silently drop
    // all but the last.
    install({ CategoryRateRules: [
      rule({ _id: 'a', key: 'a', minDays: 1, maxDays: 3 }),
      rule({ _id: 'b', key: 'b', minDays: 4, maxDays: 0 }),
    ] });
    const snapshot = await catalog();
    expect(Array.isArray(snapshot.maps.categoryRateRules)).toBe(true);
    expect(snapshot.maps.categoryRateRules).toHaveLength(2);
  });
});

describe('pickup locations', () => {
  const place = (extra = {}) => ({ _id: 'p-1', label: 'Airport', ...extra });

  test('a stored row becomes a location with sensible defaults', async () => {
    install({ PickupLocations: [place({ key: 'airport' })] });
    expect((await catalog()).pickupLocations[0]).toMatchObject({
      _id: 'p-1', key: 'airport', label: 'Airport',
      locationType: 'both', stationKey: 'default', extraFee: 0,
    });
  });

  test('a location with no station falls back to the central one, by name too', async () => {
    install({ PickupLocations: [place({ key: 'airport' })] });
    expect((await catalog()).pickupLocations[0].stationLabel).toBe('Κεντρικός σταθμός');
  });

  test('an empty station label falls back rather than being stored blank', async () => {
    install({ PickupLocations: [place({ key: 'airport', stationLabel: '' })] });
    expect((await catalog()).pickupLocations[0].stationLabel).toBe('Κεντρικός σταθμός');
  });

  test('an explicit station is kept, key normalised and label as written', async () => {
    install({ PickupLocations: [place({ key: 'airport', stationKey: 'ATH Terminal 1', stationLabel: 'Athens T1' })] });
    expect((await catalog()).pickupLocations[0]).toMatchObject({
      stationKey: 'ath_terminal_1', stationLabel: 'Athens T1',
    });
  });

  test('the station is read under any of its aliases', async () => {
    install({ PickupLocations: [
      { _id: 'a', label: 'A', stationCode: 'north' },
      { _id: 'b', label: 'B', station: 'south' },
      { _id: 'c', label: 'C', hub: 'east' },
      { _id: 'd', label: 'D', group: 'west' },
    ] });
    expect((await catalog()).pickupLocations.map((r) => r.stationKey))
      .toEqual(['north', 'south', 'east', 'west']);
  });

  test('an empty locationType falls back to both rather than being stored blank', async () => {
    install({ PickupLocations: [place({ key: 'airport', locationType: '' })] });
    expect((await catalog()).pickupLocations[0].locationType).toBe('both');
  });

  test('an explicit locationType is kept', async () => {
    install({ PickupLocations: [place({ key: 'airport', type: 'pickup' })] });
    expect((await catalog()).pickupLocations[0].locationType).toBe('pickup');
  });

  test('the surcharge is read under any of its three spellings', async () => {
    install({ PickupLocations: [
      { _id: 'a', label: 'A', extraFee: 10 },
      { _id: 'b', label: 'B', fee: 20 },
      { _id: 'c', label: 'C', price: 30 },
    ] });
    expect((await catalog()).pickupLocations.map((r) => r.extraFee)).toEqual([10, 20, 30]);
  });

  test('showOriginField is null when unset, not true', async () => {
    // Deliberately tri-state: null means "the site decides", which is not the
    // same as an operator having ticked the box. Collapsing it to a boolean
    // would turn every silent row into an explicit yes.
    install({ PickupLocations: [place({ key: 'airport' })] });
    expect((await catalog()).pickupLocations[0].showOriginField).toBeNull();
  });

  test('an explicit null is still null, not the default yes', async () => {
    // The guard checks undefined *and* null. A CMS row that stores an empty
    // toggle as null must land in the same tri-state as one that omits it —
    // without the null half, readBool(null, true) would answer yes.
    install({ PickupLocations: [place({ key: 'airport', showOriginField: null })] });
    expect((await catalog()).pickupLocations[0].showOriginField).toBeNull();
  });

  test('showOriginField set to false stays false', async () => {
    install({ PickupLocations: [place({ key: 'airport', showOriginField: false })] });
    expect((await catalog()).pickupLocations[0].showOriginField).toBe(false);
  });

  test('showOriginField set to a CMS string is read as a boolean', async () => {
    install({ PickupLocations: [place({ key: 'airport', showOriginField: 'no' })] });
    expect((await catalog()).pickupLocations[0].showOriginField).toBe(false);
  });

  test('the key can be derived from the address when nothing else is given', async () => {
    // The chain is key || slug || code || label || title || address, so the row
    // has to be genuinely unlabelled for the address to be reached.
    install({ PickupLocations: [{ _id: 'p-1', address: 'Ermou 5, Athens' }] });
    expect((await catalog()).pickupLocations[0].key).toBe('ermou_5_athens');
  });

  test('the free-text prompts are carried through for the booking form', async () => {
    install({ PickupLocations: [place({
      key: 'airport',
      pickupInfoLabel: 'Flight number', pickupInfoPlaceholder: 'e.g. A3 610',
      originFieldLabel: 'Coming from', originFieldPlaceholder: 'City',
      dropoffInfoLabel: 'Return notes', dropoffInfoPlaceholder: 'optional',
      mapUrl: 'https://maps.example/ath',
    })] });
    expect((await catalog()).pickupLocations[0]).toMatchObject({
      pickupInfoLabel: 'Flight number', pickupInfoPlaceholder: 'e.g. A3 610',
      originFieldLabel: 'Coming from', originFieldPlaceholder: 'City',
      dropoffInfoLabel: 'Return notes', dropoffInfoPlaceholder: 'optional',
      mapUrl: 'https://maps.example/ath',
    });
  });

  test('an inactive location is left out', async () => {
    install({ PickupLocations: [place({ key: 'airport', active: false })] });
    expect((await catalog()).pickupLocations).toEqual([]);
  });
});

describe('the public scope', () => {
  const hidden = { publicVisible: false };

  test('hides a season the operator marked internal', async () => {
    install({ PricingSeasons: [
      { _id: 'a', key: 'public', label: 'Public', startDate: '2026-06-01', endDate: '2026-09-01' },
      { _id: 'b', key: 'internal', label: 'Internal', startDate: '2026-06-01', endDate: '2026-09-01', ...hidden },
    ] });
    expect((await catalog('public')).pricingSeasons.map((r) => r.key)).toEqual(['public']);
    // Ordered by the positional sortOrder fallback, not alphabetically.
    expect((await catalog('all')).pricingSeasons.map((r) => r.key)).toEqual(['public', 'internal']);
  });

  test('hides an internal rate rule', async () => {
    install({ CategoryRateRules: [
      { _id: 'a', key: 'shown', label: 'Shown', categoryCode: 'ECO', pricePerDay: 45 },
      { _id: 'b', key: 'secret', label: 'Secret', categoryCode: 'ECO', pricePerDay: 20, ...hidden },
    ] });
    expect((await catalog('public')).categoryRateRules.map((r) => r.key)).toEqual(['shown']);
    expect((await catalog('all')).categoryRateRules).toHaveLength(2);
  });

  test('hides an internal pickup location', async () => {
    install({ PickupLocations: [
      { _id: 'a', key: 'airport', label: 'Airport' },
      { _id: 'b', key: 'depot', label: 'Depot', ...hidden },
    ] });
    expect((await catalog('public')).pickupLocations.map((r) => r.key)).toEqual(['airport']);
    expect((await catalog('all')).pickupLocations).toHaveLength(2);
  });

  test('an unrecognised scope is treated as public, not as all', async () => {
    // getPricingCatalog narrows anything that is not exactly 'all' — so a typo
    // fails closed, showing less rather than more.
    install({ PickupLocations: [{ _id: 'b', key: 'depot', label: 'Depot', ...hidden }] });
    expect((await getPricingCatalog({ scope: 'everything', force: true })).pickupLocations).toEqual([]);
  });

  test('getPublicPricingCatalog is the public scope', async () => {
    install({ PickupLocations: [{ _id: 'b', key: 'depot', label: 'Depot', ...hidden }] });
    clearPricingCatalogCache();
    expect((await getPublicPricingCatalog()).pickupLocations).toEqual([]);
  });

  test('an inactive row is hidden from both scopes, not just the public one', async () => {
    install({ PickupLocations: [{ _id: 'a', key: 'airport', label: 'Airport', active: false }] });
    expect((await catalog('public')).pickupLocations).toEqual([]);
    expect((await catalog('all')).pickupLocations).toEqual([]);
  });
});

describe('merging shipped defaults with stored rows', () => {
  test('a stored row wins over the shipped default of the same key', async () => {
    install({ InsurancePlans: [{ _id: 'i-1', key: 'cdw', label: 'CDW', pricePerDay: 35 }] });
    const plans = (await catalog()).insurancePlans;
    expect(plans.filter((p) => p.key === 'cdw')).toHaveLength(1);
    expect(plans.find((p) => p.key === 'cdw').pricePerDay).toBe(35);
  });

  test('a shipped default with no stored row still appears', async () => {
    // This is the mechanism behind the delete-vs-fallback behaviour reported in
    // #252: removing the stored row does not remove the option, it restores the
    // shipped price. Pinned here at its source.
    install({ InsurancePlans: [] });
    expect((await catalog()).insurancePlans.map((p) => p.key)).toContain('cdw');
  });

  test('a stored row with a key of its own is added alongside the defaults', async () => {
    install({ InsurancePlans: [{ _id: 'i-9', key: 'housecover', label: 'House cover', pricePerDay: 12 }] });
    const keys = (await catalog()).insurancePlans.map((p) => p.key);
    expect(keys).toContain('housecover');
    expect(keys).toContain('cdw');
  });

  test('the stored id replaces the default row\'s, so a save lands on the right record', async () => {
    install({ InsurancePlans: [{ _id: 'i-1', key: 'cdw', label: 'CDW', pricePerDay: 35 }] });
    expect((await catalog()).insurancePlans.find((p) => p.key === 'cdw')._id).toBe('i-1');
  });

  test('the shipped defaults carry no id, so the merged id is always the stored one', async () => {
    // Worth stating because it makes the `row._id || base._id` fallback in the
    // merge unreachable in practice: bookingConfig's options have no _id at all,
    // so there is never a default id to fall back to. Swapping the two sides of
    // that `||` changes nothing today — this test is what says why.
    install({ InsurancePlans: [] });
    const shipped = (await catalog()).insurancePlans;
    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.every((p) => p._id === '')).toBe(true);
  });

  test('a stored row with no label is dropped rather than shown blank', async () => {
    install({ InsurancePlans: [{ _id: 'i-9', key: 'mystery', label: '', pricePerDay: 5 }] });
    expect((await catalog()).insurancePlans.map((p) => p.key)).not.toContain('mystery');
  });

  test('deactivating a stored row removes the merged option entirely', async () => {
    install({ InsurancePlans: [{ _id: 'i-1', key: 'cdw', label: 'CDW', pricePerDay: 35, active: false }] });
    expect((await catalog()).insurancePlans.map((p) => p.key)).not.toContain('cdw');
  });

  test('the insurance map carries the merged price, not the shipped one', async () => {
    install({ InsurancePlans: [{ _id: 'i-1', key: 'cdw', label: 'CDW', pricePerDay: 35 }] });
    expect((await catalog()).maps.insurance.cdw).toBe(35);
  });

  test('an extra carries its billing mode into the map', async () => {
    install({ ExtraServices: [
      { _id: 'x-1', key: 'gps', label: 'GPS', price: 5, billingMode: 'perDay' },
      { _id: 'x-2', key: 'delivery', label: 'Delivery', price: 30, billingMode: 'perBooking' },
    ] });
    const map = (await catalog()).maps.extras;
    expect(map.gps).toMatchObject({ price: 5, mode: 'perDay', label: 'GPS' });
    expect(map.delivery).toMatchObject({ price: 30, mode: 'perBooking', label: 'Delivery' });
  });

  test('an unrecognised billing mode falls back to per-day', async () => {
    // Narrowed twice over: normalizeExtra already reduces the mode to one of the
    // two before the map is built, so the map's own ternary can never see
    // anything else. Asserted on both so the row and the map cannot drift.
    install({ ExtraServices: [{ _id: 'x-1', key: 'gps', label: 'GPS', price: 5, billingMode: 'perFortnight' }] });
    const snapshot = await catalog();
    expect(snapshot.extraServices.find((x) => x.key === 'gps').billingMode).toBe('perDay');
    expect(snapshot.maps.extras.gps.mode).toBe('perDay');
  });
});

describe('the cache', () => {
  // fake.rows() hands back copies, so a row has to be inserted through wixData
  // to actually reach the store — pushing onto the returned array changes
  // nothing, and a cache test written that way passes whether the cache works
  // or not.
  const addSeason = () => wixData.insert(SEASONS, {
    _id: 's', key: 'summer', label: 'Summer', startDate: '2026-06-01', endDate: '2026-09-01',
  }, { suppressAuth: true });

  test('a stored row added after the first read is not seen until the cache clears', async () => {
    install({ PricingSeasons: [] });
    expect((await getPricingCatalog({ scope: 'all' })).pricingSeasons).toEqual([]);

    await addSeason();
    expect(fake.rows(SEASONS)).toHaveLength(1);
    expect((await getPricingCatalog({ scope: 'all' })).pricingSeasons).toEqual([]);

    clearPricingCatalogCache();
    expect((await getPricingCatalog({ scope: 'all' })).pricingSeasons).toHaveLength(1);
  });

  test('force bypasses the cache', async () => {
    install({ PricingSeasons: [] });
    await getPricingCatalog({ scope: 'all' });
    await addSeason();

    expect((await getPricingCatalog({ scope: 'all', force: true })).pricingSeasons).toHaveLength(1);
  });

  test('and refreshes the cache for the callers that follow it', async () => {
    install({ PricingSeasons: [] });
    await getPricingCatalog({ scope: 'all' });
    await addSeason();
    await getPricingCatalog({ scope: 'all', force: true });

    expect((await getPricingCatalog({ scope: 'all' })).pricingSeasons).toHaveLength(1);
  });

  test('the two scopes are cached separately', async () => {
    // A public read must not be able to serve an internal one from cache, or
    // hidden rows would leak the moment an admin looked at the screen.
    install({ PickupLocations: [{ _id: 'b', key: 'depot', label: 'Depot', publicVisible: false }] });
    expect((await getPricingCatalog({ scope: 'public' })).pickupLocations).toEqual([]);
    expect((await getPricingCatalog({ scope: 'all' })).pickupLocations).toHaveLength(1);
  });

  test('and the reverse order works too', async () => {
    install({ PickupLocations: [{ _id: 'b', key: 'depot', label: 'Depot', publicVisible: false }] });
    expect((await getPricingCatalog({ scope: 'all' })).pickupLocations).toHaveLength(1);
    expect((await getPricingCatalog({ scope: 'public' })).pickupLocations).toEqual([]);
  });

  test('each caller gets its own copy, so one cannot corrupt the next', async () => {
    // The catalogue is handed out as a deep clone. Without that, a caller that
    // edited a rule in place would change the prices every later quote used.
    install({ CategoryRateRules: [{ _id: 'r', key: 'r', label: 'ECO', categoryCode: 'ECO', pricePerDay: 45 }] });
    const first = await getPricingCatalog({ scope: 'all' });
    first.categoryRateRules[0].pricePerDay = 999;
    first.businessSettings.currency = 'XXX';

    const second = await getPricingCatalog({ scope: 'all' });
    expect(second.categoryRateRules[0].pricePerDay).toBe(45);
    expect(second.businessSettings.currency).not.toBe('XXX');
  });

  test('the copy served from cache is a copy too', async () => {
    // The first call clones on the way out of the build, so mutating it says
    // nothing about the cached branch — that branch clones separately, and only
    // a mutation of a *cache-served* result can tell whether it does.
    install({ CategoryRateRules: [{ _id: 'r', key: 'r', label: 'ECO', categoryCode: 'ECO', pricePerDay: 45 }] });
    await getPricingCatalog({ scope: 'all' });

    const cached = await getPricingCatalog({ scope: 'all' });
    cached.categoryRateRules[0].pricePerDay = 999;

    const next = await getPricingCatalog({ scope: 'all' });
    expect(next.categoryRateRules[0].pricePerDay).toBe(45);
  });

  test('the cache goes stale on its own after the TTL', async () => {
    // Nothing else here waits, so an always-fresh cache would look identical.
    install({ PricingSeasons: [] });
    expect((await getPricingCatalog({ scope: 'all' })).pricingSeasons).toEqual([]);
    await addSeason();
    expect((await getPricingCatalog({ scope: 'all' })).pricingSeasons).toEqual([]);

    const realNow = Date.now;
    Date.now = () => realNow() + 61 * 1000;
    try {
      expect((await getPricingCatalog({ scope: 'all' })).pricingSeasons).toHaveLength(1);
    } finally {
      Date.now = realNow;
    }
  });

  test('clearing the cache reports that it did', async () => {
    expect(clearPricingCatalogCache()).toBe(true);
  });
});

describe('when a collection is unavailable', () => {
  test('the catalogue still builds, with that source empty', async () => {
    // safeQuery swallows the failure per collection, so one missing CMS
    // collection cannot take the whole quote engine down with it.
    clearPricingCatalogCache();
    fake = createFakeWixData(seed(), { strictCollections: true }).install(wixData);
    // Remove one collection from the store entirely.
    const original = wixData.query;
    wixData.query = (collection) => {
      if (collection === RATES) throw new Error('CategoryRateRules does not exist');
      return original(collection);
    };

    const snapshot = await catalog();
    expect(snapshot.categoryRateRules).toEqual([]);
    expect(snapshot.businessSettings).toBeTruthy();
    expect(snapshot.insurancePlans.length).toBeGreaterThan(0);
  });

  test('business settings fall back to the shipped defaults when there are none', async () => {
    install({ BusinessSettings: [] });
    const settings = (await catalog()).businessSettings;
    expect(settings).toBeTruthy();
    expect(typeof settings.nightStartHour).toBe('number');
  });
});

describe('getPricingMaps', () => {
  test('hands back the catalogue alongside the lookup maps', async () => {
    install({
      InsurancePlans: [{ _id: 'i-1', key: 'cdw', label: 'CDW', pricePerDay: 35 }],
      CategoryRateRules: [{ _id: 'r', key: 'r', label: 'ECO', categoryCode: 'ECO', pricePerDay: 45 }],
      PickupLocations: [{ _id: 'p', key: 'airport', label: 'Airport' }],
    });
    const maps = await getPricingMaps({ scope: 'all', force: true });

    expect(maps.insuranceMap.cdw).toBe(35);
    expect(maps.categoryRateRules).toHaveLength(1);
    expect(maps.pickupLocationsMap).toHaveLength(1);
    expect(maps.businessSettings).toBeTruthy();
  });

  test('defaults to the public scope', async () => {
    install({ PickupLocations: [{ _id: 'p', key: 'depot', label: 'Depot', publicVisible: false }] });
    const maps = await getPricingMaps({ force: true });
    expect(maps.pickupLocations).toEqual([]);
  });
});

describe('station settings on the business record', () => {
  test('a keyed map of per-station overrides is normalised by key', async () => {
    install({ BusinessSettings: [{
      _id: 'bs-1', currency: 'EUR',
      stationSettings: { 'ATH Terminal 1': { nightStartHour: 23 }, thessaloniki: { nightStartHour: 22 } },
    }] });
    const settings = (await catalog()).businessSettings;
    expect(Object.keys(settings.stationSettings).sort()).toEqual(['ath_terminal_1', 'thessaloniki']);
    expect(settings.stationSettings.ath_terminal_1).toMatchObject({ nightStartHour: 23 });
  });

  test('an entry that is not an object is dropped rather than stored', async () => {
    install({ BusinessSettings: [{
      _id: 'bs-1', currency: 'EUR',
      stationSettings: { good: { nightStartHour: 23 }, bad: 'not-a-record', alsoBad: [1, 2], nope: null },
    }] });
    expect(Object.keys((await catalog()).businessSettings.stationSettings)).toEqual(['good']);
  });

  test('a stationSettings that is not a map at all becomes an empty one', async () => {
    // The array has to hold objects to test the guard that rejects arrays: an
    // array of strings is dropped one line later by the per-entry check, so it
    // would look the same either way.
    install({ BusinessSettings: [{
      _id: 'bs-1', currency: 'EUR',
      stationSettings: [{ nightStartHour: 23 }, { nightStartHour: 22 }],
    }] });
    expect((await catalog()).businessSettings.stationSettings).toEqual({});
  });

  test('a missing stationSettings is an empty map, not undefined', async () => {
    install({ BusinessSettings: [{ _id: 'bs-1', currency: 'EUR' }] });
    expect((await catalog()).businessSettings.stationSettings).toEqual({});
  });
});

describe('breaking ties between equally good rules', () => {
  // The last resort in both sorts, and the only thing standing between an
  // ambiguous configuration and an arbitrary price.
  const season = (key, sortOrder) => ({
    key, label: key, startDate: '2026-06-01', endDate: '2026-09-01',
    priority: 5, sortOrder, active: true,
  });

  test('two seasons matching the same date with equal priority are decided by sort order', async () => {
    const catalogue = {
      pricingSeasons: [season('late', 20), season('early', 10)],
      categoryRateRules: [],
    };
    const resolved = resolveDynamicPricingRate({
      categoryCode: 'ECO', billableDays: 3,
      pickupDateTime: new Date('2026-07-01T10:00:00.000Z'),
      catalog: catalogue, fallbackPricePerDay: 40,
    });
    expect(resolved.season.key).toBe('early');
  });

  test('priority still wins over sort order', async () => {
    const catalogue = {
      pricingSeasons: [
        { ...season('low', 10), priority: 1 },
        { ...season('high', 20), priority: 9 },
      ],
      categoryRateRules: [],
    };
    const resolved = resolveDynamicPricingRate({
      categoryCode: 'ECO', billableDays: 3,
      pickupDateTime: new Date('2026-07-01T10:00:00.000Z'),
      catalog: catalogue, fallbackPricePerDay: 40,
    });
    expect(resolved.season.key).toBe('high');
  });

  test('two rate rules of identical specificity are decided by sort order', async () => {
    // Same category, same season, same day range — nothing left to separate
    // them but the order an operator gave them.
    const rule = (key, pricePerDay, sortOrder) => ({
      key, label: key, categoryCode: 'ECO', seasonKey: '',
      minDays: 1, maxDays: 7, pricePerDay, sortOrder, active: true,
    });
    const resolved = resolveDynamicPricingRate({
      categoryCode: 'ECO', billableDays: 3,
      catalog: { pricingSeasons: [], categoryRateRules: [rule('second', 99, 20), rule('first', 45, 10)] },
      fallbackPricePerDay: 40,
    });
    expect(resolved.rule.key).toBe('first');
    expect(resolved.pricePerDay).toBe(45);
  });

  test('a narrower day range still wins over sort order', async () => {
    const wide = { key: 'wide', label: 'wide', categoryCode: 'ECO', minDays: 1, maxDays: 30, pricePerDay: 60, sortOrder: 1, active: true };
    const narrow = { key: 'narrow', label: 'narrow', categoryCode: 'ECO', minDays: 1, maxDays: 7, pricePerDay: 45, sortOrder: 99, active: true };
    const resolved = resolveDynamicPricingRate({
      categoryCode: 'ECO', billableDays: 3,
      catalog: { pricingSeasons: [], categoryRateRules: [wide, narrow] },
      fallbackPricePerDay: 40,
    });
    expect(resolved.rule.key).toBe('narrow');
  });
});
