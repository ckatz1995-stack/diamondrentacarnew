import { bootPageController, createComponent } from '../../../test/helpers/bootPageController.js';
import { BRIDGE_TYPES } from '../../public/bridgeUtils.js';

// The vehicles listing page. Its distinguishing feature is that what it lists
// is a business setting, not a fixed choice: the page can show rental
// categories, or individual models drawn from the fleet, or individual models
// drawn from the categories table dressed up as model cards. Three sources,
// selected by two settings that arrive inside the pricing catalogue — so the
// listing cannot even be fetched until the catalogue has landed.
//
// That ordering is what the two epoch guards protect. A catalogue fetch and a
// listing fetch can both be in flight across a client-side route change, and
// each checks on arrival whether the page it was started for is still the page
// on screen.

const COMP = '#bpage2';
const TRUSTED = 'https://editor.wix.com';
const URL = 'https://diamond.example/categories';
const RUNGS = [80, 260, 700, 1400, 2400, 4200, 6200];

const seed = (settings = {}) => ({
  BusinessSettings: [{ _id: 'bs-1', currency: 'EUR', ...settings }],
  InsurancePlans: [],
  ExtraServices: [],
  FeeRules: [],
  PricingSeasons: [],
  CategoryRateRules: [],
  PickupLocations: [],
  VehiclesNew: [
    { _id: 'cat-1', category: 'ECO', title: 'Economy', price: 30, active: true },
    { _id: 'cat-2', category: 'SUV', title: 'SUV', price: 70, active: true },
  ],
  FleetNew: [
    { _id: 'f-1', category: 'ECO', model: 'Fiat Panda', plate: 'AAA-1', active: true },
    { _id: 'f-2', category: 'SUV', model: 'Jeep Renegade', plate: 'BBB-2', active: true },
  ],
});

let ctx;
let html;
let errors;

async function boot({ settings = {}, bare = false, query = {}, component = null, extras = {}, beforeStart = null } = {}) {
  html = component || createComponent(COMP);
  ctx = await bootPageController({
    importer: () => import('../Categories.qtahg.js'),
    components: bare ? {} : { [COMP]: html, ...extras },
    seed: seed(settings),
    query,
    url: URL,
    path: ['categories'],
    beforeStart,
  });
  await flush();
  return ctx;
}

const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
const runLadder = async () => { jest.advanceTimersByTime(7000); await flush(); };
const send = (msg, origin = TRUSTED) => html.emitMessage({ origin, data: msg });
const of = (type) => html.postedOfType(type);
const last = (type) => of(type).pop();
const navigatedTo = () => ctx.wixLocation.to.mock.calls.map((c) => c[0]);

beforeEach(() => { errors = jest.spyOn(console, 'error').mockImplementation(() => {}); });

afterEach(async () => {
  if (ctx) await ctx.teardown();
  ctx = null;
  html = null;
  errors.mockRestore();
});

describe('what the page lists', () => {
  test('by default it lists rental categories', async () => {
    await boot();
    await runLadder();

    expect(last('vehicles-data').meta).toEqual({ displayMode: 'categories', modelsSource: 'fleet' });
    expect(last('vehicles-data').items.map((i) => i.categoryCode)).toEqual(['ECO', 'SUV']);
  });

  test('set to models over the fleet, it lists the cars themselves', async () => {
    await boot({ settings: { vehiclesPageDisplayMode: 'models', vehiclesPageModelsSource: 'fleet' } });
    await runLadder();

    expect(last('vehicles-data').meta).toEqual({ displayMode: 'models', modelsSource: 'fleet' });
    expect(last('vehicles-data').items.map((i) => i.model).sort()).toEqual(['Fiat Panda', 'Jeep Renegade']);
  });

  test('set to models over the categories table, each row becomes a model card', async () => {
    await boot({ settings: { vehiclesPageDisplayMode: 'models', vehiclesPageModelsSource: 'vehicles' } });
    await runLadder();

    const items = last('vehicles-data').items;
    expect(last('vehicles-data').meta).toEqual({ displayMode: 'models', modelsSource: 'vehicles' });
    expect(items.every((i) => i.itemType === 'model' && i.source === 'vehicles')).toBe(true);
    // One name, copied across every field a card might read it from.
    expect(items[0]).toMatchObject({
      model: items[0].title, name: items[0].title,
      displayName: items[0].title, displayTitle: items[0].title,
    });
  });

  test('a model card falls back through the name fields, and ends at a placeholder', async () => {
    // getVehicleCategoriesCatalog maps rows before the page sees them, so the
    // card builder's fallback chain is reached with whatever that mapper left
    // behind — down to a row with no usable name at all.
    await boot({
      settings: { vehiclesPageDisplayMode: 'models', vehiclesPageModelsSource: 'vehicles' },
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.getVehicleCategoriesCatalog = () => Promise.resolve([
          { categoryCode: 'ECO', pricePerDay: 30, _id: 'row-1' },
          { category: 'SUV' },
          {},
        ]);
      },
    });
    await runLadder();

    const items = last('vehicles-data').items;
    expect(items.map((i) => i.model)).toEqual(['ECO', 'SUV', 'Μοντέλο']);
    expect(items.map((i) => i.categoryLabel)).toEqual(['ECO', 'SUV', '']);
    // The card is the original row plus the model dressing, not a replacement:
    // everything the frame renders from — price, id — has to survive the map.
    expect(items[0]).toMatchObject({ _id: 'row-1', pricePerDay: 30, itemType: 'model', source: 'vehicles' });
  });

  test.each([
    ['an unknown display mode', { vehiclesPageDisplayMode: 'carousel' }],
    ['a blank display mode', { vehiclesPageDisplayMode: '   ' }],
  ])('%s falls back to listing categories', async (_label, settings) => {
    await boot({ settings });
    await runLadder();

    expect(last('vehicles-data').meta.displayMode).toBe('categories');
    expect(of('vehicles-data-error')).toEqual([]);
  });

  test('a display mode in the wrong case is still honoured', async () => {
    // Mutation note: the page lowercases the setting, but normalizeBusinessSettings
    // has already done so by the time it arrives, so dropping the page's call is
    // an equivalent mutant. The behaviour is pinned here regardless.
    await boot({ settings: { vehiclesPageDisplayMode: 'MODELS' } });
    await runLadder();

    expect(last('vehicles-data').meta.displayMode).toBe('models');
  });

  test('an unknown models source falls back to the fleet', async () => {
    await boot({ settings: { vehiclesPageDisplayMode: 'models', vehiclesPageModelsSource: 'somewhere-else' } });
    await runLadder();

    expect(last('vehicles-data').meta.modelsSource).toBe('fleet');
  });
});

describe('opening the page', () => {
  test('nothing is posted before the first rung comes due', async () => {
    await boot();
    jest.advanceTimersByTime(RUNGS[0] - 1);
    await flush();

    expect(html.posted).toEqual([]);
  });

  test('the catalogue, the context and the listing each go out seven times', async () => {
    await boot();
    await runLadder();

    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(7);
    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(7);
    expect(of('vehicles-data')).toHaveLength(7);
  });

  test.each(RUNGS.map((ms, i) => [ms, i + 1]))(
    'by %sms the frame has had %s attempts',
    async (elapsed, attempts) => {
      await boot();
      jest.advanceTimersByTime(elapsed);
      await flush();

      expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(attempts);
    },
  );

  test('the listing is fetched on ready, before any rung comes due', async () => {
    let calls = 0;
    await boot({
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        const real = engine.getVehicleCategoriesCatalog;
        engine.getVehicleCategoriesCatalog = (...args) => { calls += 1; return real(...args); };
      },
    });

    expect(calls).toBe(1);
    await runLadder();
    expect(calls).toBe(1);
  });

  test('the context carries the page URL, path and query', async () => {
    await boot({ query: { category: 'ECO' } });
    await runLadder();

    expect(of(BRIDGE_TYPES.CONTEXT)[0]).toMatchObject({
      url: URL, path: ['categories'], query: { category: 'ECO' },
    });
  });

  test('a page with no frame logs and stops', async () => {
    await boot({ bare: true });
    await runLadder();

    expect(errors).toHaveBeenCalledWith('Categories HTML component not found');
    expect(ctx.wixLocation.__changeHandlerCount()).toBe(0);
  });

  test('a frame that refuses the binding still gets its payloads', async () => {
    const stubborn = createComponent(COMP, { onMessage() { throw new Error('already bound'); } });
    await boot({ component: stubborn });
    await runLadder();

    expect(errors).toHaveBeenCalledWith('Bind categories html onMessage failed', expect.any(Error));
    expect(of('vehicles-data')).toHaveLength(7);
  });

  test.each(['#categoriesHtml', '#vehiclesHtml'])('the fallback component id %s is used', async (id) => {
    // A stray frame is declared ahead of it, so the type-selector fallback in
    // resolveHtmlComponent would pick the wrong one; only the candidate list
    // gets this right.
    const stray = createComponent('#marketingHtml');
    const alt = createComponent(id);
    ctx = await bootPageController({
      importer: () => import('../Categories.qtahg.js'),
      components: { '#marketingHtml': stray, [id]: alt },
      seed: seed(),
      url: URL,
      path: ['categories'],
    });
    html = alt;
    await runLadder();

    expect(of('vehicles-data')).toHaveLength(7);
    expect(stray.posted).toEqual([]);
  });

  test('the named candidates outrank whatever HtmlComponent comes first', async () => {
    const stray = createComponent('#marketingHtml');
    await boot({ extras: { '#marketingHtml': stray } });
    await runLadder();

    expect(of('vehicles-data')).toHaveLength(7);
    expect(stray.posted).toEqual([]);
  });
});

describe('a client-side route change', () => {
  test('clears both caches and re-fetches', async () => {
    let listings = 0;
    let catalogues = 0;
    await boot({
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        const pricing = await import('../../backend/pricingCatalog.jsw');
        const realList = engine.getVehicleCategoriesCatalog;
        const realCat = pricing.getPublicPricingCatalog;
        engine.getVehicleCategoriesCatalog = (...a) => { listings += 1; return realList(...a); };
        pricing.getPublicPricingCatalog = (...a) => { catalogues += 1; return realCat(...a); };
      },
    });
    await runLadder();
    expect([listings, catalogues]).toEqual([1, 1]);

    ctx.wixLocation.__emitChange({ path: ['categories', 'suv'] });
    await runLadder();

    expect(of('vehicles-data')).toHaveLength(14);
    expect([listings, catalogues]).toEqual([2, 2]);
  });

  test('the change handler is registered exactly once', async () => {
    await boot();

    expect(ctx.wixLocation.__changeHandlerCount()).toBe(1);
  });

  test('a listing waiting on the catalogue is abandoned when the route changes under it', async () => {
    // This is the window the listing's own epoch check covers: ensureVehicles
    // parks on `await ensurePricingCatalog()`, and re-checks the epoch when it
    // wakes. If the visitor has moved on by then it gives up before spending a
    // fetch on a page nobody is looking at.
    let listingCalls = 0;
    let pendingCatalogue = null;
    await boot({
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        const pricing = await import('../../backend/pricingCatalog.jsw');
        const realList = engine.getVehicleCategoriesCatalog;
        const realCat = pricing.getPublicPricingCatalog;
        engine.getVehicleCategoriesCatalog = (...a) => { listingCalls += 1; return realList(...a); };
        let catalogueCalls = 0;
        pricing.getPublicPricingCatalog = (...a) => {
          catalogueCalls += 1;
          if (catalogueCalls !== 2) return realCat(...a);
          return new Promise((resolve) => { pendingCatalogue = resolve; });
        };
      },
    });
    await runLadder();
    expect(listingCalls).toBe(1);

    // Asked directly rather than through a rung: syncAll awaits the catalogue
    // before it calls sendVehicles, so only a direct request gets ensureVehicles
    // parked on the catalogue while it is still in flight.
    ctx.wixLocation.__emitChange({ path: ['categories', 'suv'] });
    const parked = send({ type: 'request-vehicles-data' });
    await flush();
    expect(pendingCatalogue).toBeInstanceOf(Function);

    ctx.wixLocation.__emitChange({ path: ['categories', 'eco'] });
    pendingCatalogue({ businessSettings: {}, insurancePlans: [] });
    await parked;
    await flush();

    // The parked generation woke up, saw it was stale, and stopped.
    expect(listingCalls).toBe(1);
  });

  test('a listing already fetching when the route changes still fills the new cache', async () => {
    // Pinned as it behaves, and worth stating plainly: the epoch is checked
    // before the listing fetch is started but not after it resolves, so this
    // half of the race is unguarded — unlike the catalogue, which re-checks on
    // arrival. Today the listing does not vary by route, so a stale answer is
    // the same answer; the asymmetry only bites if the two fetches straddle a
    // change to the display-mode settings.
    let calls = 0;
    let pending = null;
    await boot({
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        const real = engine.getVehicleCategoriesCatalog;
        engine.getVehicleCategoriesCatalog = (...a) => {
          calls += 1;
          if (calls !== 2) return real(...a);
          return new Promise((resolve) => { pending = resolve; });
        };
      },
    });
    await runLadder();

    ctx.wixLocation.__emitChange({ path: ['categories', 'suv'] });
    jest.advanceTimersByTime(RUNGS[0]);
    await flush();
    expect(pending).toBeInstanceOf(Function);

    ctx.wixLocation.__emitChange({ path: ['categories', 'eco'] });
    pending([{ categoryCode: 'STALE', title: 'Stale' }]);
    await flush();

    expect(of('vehicles-data').some((p) => p.items.some((i) => i.categoryCode === 'STALE'))).toBe(true);
  });

  test('a catalogue fetch in flight across a route change does not fill the new cache', async () => {
    let calls = 0;
    let pending = null;
    await boot({
      async beforeStart() {
        const pricing = await import('../../backend/pricingCatalog.jsw');
        const real = pricing.getPublicPricingCatalog;
        pricing.getPublicPricingCatalog = () => {
          calls += 1;
          if (calls !== 2) return real();
          return new Promise((resolve) => { pending = resolve; });
        };
      },
    });
    await runLadder();

    ctx.wixLocation.__emitChange({ path: ['categories', 'suv'] });
    jest.advanceTimersByTime(RUNGS[0]);
    await flush();
    expect(pending).toBeInstanceOf(Function);

    ctx.wixLocation.__emitChange({ path: ['categories', 'eco'] });
    pending({ businessSettings: { vehiclesPageDisplayMode: 'models' }, insurancePlans: [] });
    await flush();
    await runLadder();

    // The stale answer named a different display mode; if it had landed, the
    // listing would have switched to models on a page that never asked.
    expect(of('vehicles-data').every((p) => p.meta.displayMode === 'categories')).toBe(true);
  });
});

describe('when a backend fails', () => {
  test('a failing listing is reported as an error payload with the reason', async () => {
    await boot({
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.getVehicleCategoriesCatalog = () => Promise.reject(new Error('fleet offline'));
      },
    });
    await runLadder();

    expect(last('vehicles-data-error')).toEqual({
      type: 'vehicles-data-error', message: 'fleet offline', items: [],
    });
    // The frame gets the error instead of the listing, not as well as it.
    expect(of('vehicles-data')).toEqual([]);
    expect(errors).toHaveBeenCalledWith('Load vehicles page catalog failed', expect.any(Error));
  });

  test('a listing failure with no message still names something', async () => {
    await boot({
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.getVehicleCategoriesCatalog = () => Promise.reject(new Error(''));
      },
    });
    await runLadder();

    expect(last('vehicles-data-error').message).toBe('Vehicles page catalog load failed');
  });

  test('a listing that answers with something that is not a list is treated as empty', async () => {
    await boot({
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.getVehicleCategoriesCatalog = () => Promise.resolve('not a list');
      },
    });
    await runLadder();

    expect(last('vehicles-data').items).toEqual([]);
    expect(of('vehicles-data-error')).toEqual([]);
  });

  test('a failing catalogue still leaves the page listing categories', async () => {
    await boot({
      async beforeStart() {
        const pricing = await import('../../backend/pricingCatalog.jsw');
        pricing.getPublicPricingCatalog = () => Promise.reject(new Error('catalogue offline'));
      },
    });
    await runLadder();

    expect(last(BRIDGE_TYPES.PRICING).catalog).toBeNull();
    expect(last('vehicles-data').meta).toEqual({ displayMode: 'categories', modelsSource: 'fleet' });
    expect(last('vehicles-data').items).toHaveLength(2);
    expect(errors).toHaveBeenCalledWith('Load pricing catalog failed', expect.any(Error));
  });

  test('a models-over-fleet page whose preview answers with no items is empty, not broken', async () => {
    await boot({
      settings: { vehiclesPageDisplayMode: 'models' },
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.getFleetModelsPreview = () => Promise.resolve({});
      },
    });
    await runLadder();

    expect(last('vehicles-data').items).toEqual([]);
    expect(of('vehicles-data-error')).toEqual([]);
  });

  test.each([
    ['null', null],
    // A truthy non-list is the case that separates the Array.isArray check from
    // a bare `|| []`: mapping over a string throws, and the page would report a
    // TypeError to the frame instead of an empty listing.
    ['a string', 'not a list'],
  ])('a models-over-vehicles page whose rows come back as %s is empty, not broken', async (_label, rows) => {
    await boot({
      settings: { vehiclesPageDisplayMode: 'models', vehiclesPageModelsSource: 'vehicles' },
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.getVehicleCategoriesCatalog = () => Promise.resolve(rows);
      },
    });
    await runLadder();

    expect(last('vehicles-data').items).toEqual([]);
    expect(of('vehicles-data-error')).toEqual([]);
  });

  test('a failure on one rung is forgotten once a later rung succeeds', async () => {
    // Without the error being cleared on success the frame would keep being told
    // the listing is broken, on every rung, for the life of the page.
    let calls = 0;
    await boot({
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        const real = engine.getVehicleCategoriesCatalog;
        engine.getVehicleCategoriesCatalog = (...a) => {
          calls += 1;
          // The first is the fetch on ready, which posts nothing; the second is
          // the first ladder rung, which is where the frame hears about it.
          return calls <= 2 ? Promise.reject(new Error('fleet offline')) : real(...a);
        };
      },
    });

    // Rung by rung: advancing the whole ladder at once fires every rung in the
    // same tick, and they all join whichever fetch the first one started.
    jest.advanceTimersByTime(RUNGS[0]);
    await flush();
    expect(of('vehicles-data-error')).toHaveLength(1);

    jest.advanceTimersByTime(RUNGS[1] - RUNGS[0]);
    await flush();

    expect(of('vehicles-data-error')).toHaveLength(1);
    expect(of('vehicles-data')).toHaveLength(1);
    expect(last('vehicles-data').items).toHaveLength(2);
  });
});

describe('messages from the frame', () => {
  beforeEach(async () => {
    await boot();
    await runLadder();
  });

  test('a context request is answered', async () => {
    await send({ type: BRIDGE_TYPES.REQUEST_CONTEXT });

    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(8);
  });

  test('a pricing request is answered', async () => {
    await send({ type: BRIDGE_TYPES.REQUEST_PRICING });
    await flush();

    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(8);
  });

  test.each(['request-vehicles-data', 'categories-ready'])('%s is answered with the listing', async (type) => {
    await send({ type });
    await flush();

    expect(of('vehicles-data')).toHaveLength(8);
  });

  // The second of two equivalent mutation survivors on this file (the first is
  // noted beside the display-mode case test): recomputing vehiclesMeta inside
  // the catalogue's `.then` is redundant. ensureVehicles recomputes it from the
  // same settings the moment the catalogue lands, and resetCaches clears both
  // together, so no observable state ever reads a meta the listing path has not
  // just written.
  test('a navigation request is followed', async () => {
    await send({ type: BRIDGE_TYPES.WIX_NAV, path: '/booking' });

    expect(navigatedTo()).toEqual(['/booking']);
  });

  test('a pathless navigation request goes nowhere', async () => {
    await send({ type: BRIDGE_TYPES.WIX_NAV });

    expect(navigatedTo()).toEqual([]);
  });

  test('a navigation that throws is logged rather than propagated', async () => {
    ctx.wixLocation.to.mockImplementation(() => { throw new Error('blocked'); });

    await send({ type: BRIDGE_TYPES.WIX_NAV, path: '/booking' });

    expect(errors).toHaveBeenCalledWith('categories navigation failed', expect.any(Error));
  });

  test('a message from an untrusted origin is ignored', async () => {
    const before = html.posted.length;
    await send({ type: BRIDGE_TYPES.REQUEST_CONTEXT }, 'https://evil.example');

    expect(html.posted.length).toBe(before);
  });

  test('an origin-less message is accepted', async () => {
    await send({ type: BRIDGE_TYPES.REQUEST_CONTEXT }, '');

    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(8);
  });

  test('an unparseable payload, a null payload and an unknown type do nothing', async () => {
    const before = html.posted.length;
    await send('{ not json');
    await send(null);
    await send({ type: 'something-else' });
    await flush();

    expect(html.posted.length).toBe(before);
  });
});

describe('messages posted to the window', () => {
  beforeEach(async () => {
    await boot();
    await runLadder();
  });

  const toWindow = async (data, origin = TRUSTED) => {
    await ctx.env.emitWindowMessage({ origin, data });
    await flush();
  };

  test('the window answers context and listing requests and navigates', async () => {
    await toWindow({ type: BRIDGE_TYPES.REQUEST_CONTEXT });
    await toWindow({ type: 'request-vehicles-data' });
    await toWindow({ type: 'categories-ready' });
    await toWindow({ type: BRIDGE_TYPES.WIX_NAV, path: '/booking' });

    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(8);
    expect(of('vehicles-data')).toHaveLength(9);
    expect(navigatedTo()).toEqual(['/booking']);
  });

  test('the window does not answer pricing requests — only the frame does', async () => {
    await toWindow({ type: BRIDGE_TYPES.REQUEST_PRICING });

    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(7);
  });

  test('an untrusted window origin is refused', async () => {
    await toWindow({ type: 'request-vehicles-data' }, 'https://evil.example');

    expect(of('vehicles-data')).toHaveLength(7);
  });

  test('a payload that will not parse is dropped', async () => {
    const before = html.posted.length;
    await toWindow('{ not json');
    await toWindow(null);

    expect(html.posted.length).toBe(before);
  });
});
