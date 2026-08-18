import { bootPageController, createComponent } from '../../../test/helpers/bootPageController.js';
import { BRIDGE_TYPES } from '../../public/bridgeUtils.js';

// The options step: the visitor has chosen a category and is picking insurance,
// extras and a specific model. Three independent caches feed it — the pricing
// catalogue, the chosen category, and the models available in that category —
// and all three are keyed on the same query string, so they must agree about
// which vehicle the page is about.
//
// Each cache carries its own epoch check, and this page checks all three on the
// way *out* of the fetch, which is the arrangement the categories page only
// half has. A route change therefore cannot leave one cache describing the old
// category while another describes the new one.

const COMP = '#bpage3';
const TRUSTED = 'https://editor.wix.com';
const URL = 'https://diamond.example/options';
const RUNGS = [80, 260, 700, 1400, 2400];

const seed = () => ({
  BusinessSettings: [{ _id: 'bs-1', currency: 'EUR' }],
  InsurancePlans: [{ _id: 'i-1', key: 'cdw', label: 'CDW', pricePerDay: 12, active: true }],
  ExtraServices: [{ _id: 'x-1', key: 'gps', label: 'GPS', price: 5, active: true }],
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
    { _id: 'f-2', category: 'ECO', model: 'VW Polo', plate: 'CCC-3', active: true },
    { _id: 'f-3', category: 'SUV', model: 'Jeep Renegade', plate: 'BBB-2', active: true },
  ],
});

let ctx;
let html;
let errors;

async function boot({ bare = false, query = { category: 'ECO' }, component = null, extras = {}, beforeStart = null } = {}) {
  html = component || createComponent(COMP);
  ctx = await bootPageController({
    importer: () => import('../Options.i5rsb.js'),
    components: bare ? {} : { [COMP]: html, ...extras },
    seed: seed(),
    query,
    url: URL,
    path: ['options'],
    beforeStart,
  });
  await flush();
  return ctx;
}

const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
const runLadder = async () => { jest.advanceTimersByTime(3000); await flush(); };
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

describe('opening the page', () => {
  test('nothing is posted before the first rung comes due', async () => {
    await boot();
    jest.advanceTimersByTime(RUNGS[0] - 1);
    await flush();

    expect(html.posted).toEqual([]);
  });

  test('all four payloads go out five times', async () => {
    await boot();
    await runLadder();

    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(5);
    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(5);
    expect(of('vehicle-category-data')).toHaveLength(5);
    expect(of('fleet-models-data')).toHaveLength(5);
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

  test('all three caches are filled on ready, before any rung comes due', async () => {
    const calls = { catalogue: 0, category: 0, fleet: 0 };
    await boot({
      async beforeStart() {
        const pricing = await import('../../backend/pricingCatalog.jsw');
        const engine = await import('../../backend/bookingEngine.jsw');
        const realCat = pricing.getPublicPricingCatalog;
        const realItem = engine.getVehicleCategoryDetails;
        const realFleet = engine.getFleetModelsPreview;
        pricing.getPublicPricingCatalog = (...a) => { calls.catalogue += 1; return realCat(...a); };
        engine.getVehicleCategoryDetails = (...a) => { calls.category += 1; return realItem(...a); };
        engine.getFleetModelsPreview = (...a) => { calls.fleet += 1; return realFleet(...a); };
      },
    });

    expect(calls).toEqual({ catalogue: 1, category: 1, fleet: 1 });
    await runLadder();
    expect(calls).toEqual({ catalogue: 1, category: 1, fleet: 1 });
  });

  test('the three payloads describe the same category', async () => {
    await boot({ query: { category: 'ECO' } });
    await runLadder();

    expect(last('vehicle-category-data').item).toMatchObject({ categoryCode: 'ECO' });
    expect(last('fleet-models-data').items.map((i) => i.model).sort()).toEqual(['Fiat Panda', 'VW Polo']);
    expect(last(BRIDGE_TYPES.PRICING).catalog).toMatchObject({
      insurancePlans: [expect.objectContaining({ key: 'cdw' })],
    });
  });

  test('the context carries the page URL, path and query', async () => {
    await boot({ query: { category: 'SUV' } });
    await runLadder();

    expect(of(BRIDGE_TYPES.CONTEXT)[0]).toMatchObject({
      url: URL, path: ['options'], query: { category: 'SUV' },
    });
  });

  test('a page with no frame logs and stops', async () => {
    await boot({ bare: true });
    await runLadder();

    expect(errors).toHaveBeenCalledWith('Options HTML component not found');
    expect(ctx.wixLocation.__changeHandlerCount()).toBe(0);
  });

  test('a frame that refuses the binding still gets its payloads', async () => {
    const stubborn = createComponent(COMP, { onMessage() { throw new Error('already bound'); } });
    await boot({ component: stubborn });
    await runLadder();

    expect(errors).toHaveBeenCalledWith('Bind options html onMessage failed', expect.any(Error));
    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(5);
  });

  test.each(['#optionsHtml', '#html1'])('the fallback component id %s is used', async (id) => {
    // A stray frame is declared ahead of it, so the type-selector fallback in
    // resolveHtmlComponent would pick the wrong one.
    const stray = createComponent('#marketingHtml');
    const alt = createComponent(id);
    ctx = await bootPageController({
      importer: () => import('../Options.i5rsb.js'),
      components: { '#marketingHtml': stray, [id]: alt },
      seed: seed(),
      query: { category: 'ECO' },
      url: URL,
      path: ['options'],
    });
    html = alt;
    await runLadder();

    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(5);
    expect(stray.posted).toEqual([]);
  });
});

describe('which vehicle the page is about', () => {
  test.each([
    ['vehicle', { vehicle: 'cat-2' }],
    ['vehicleId', { vehicleId: 'cat-2' }],
  ])('the %s query parameter selects it', async (_name, query) => {
    await boot({ query });
    await runLadder();

    expect(last('vehicle-category-data').item).toMatchObject({ categoryCode: 'SUV' });
    expect(last('fleet-models-data').items.map((i) => i.model)).toEqual(['Jeep Renegade']);
  });

  test('the category code selects it too', async () => {
    await boot({ query: { category: 'SUV' } });
    await runLadder();

    expect(last('vehicle-category-data').item).toMatchObject({ categoryCode: 'SUV' });
  });

  // Mutation note: `item || null` never sees undefined — ensureCategoryItem
  // normalises to null on the cached, resolved and failed paths alike. It is the
  // file's only surviving mutant.
  test('a URL naming no vehicle still answers, with a null item', async () => {
    await boot({ query: {} });
    await runLadder();

    expect(of('vehicle-category-data')).toHaveLength(5);
    expect(last('vehicle-category-data').item).toBeNull();
  });
});

describe('a client-side route change', () => {
  test('clears all three caches and re-fetches', async () => {
    const calls = { catalogue: 0, category: 0, fleet: 0 };
    await boot({
      async beforeStart() {
        const pricing = await import('../../backend/pricingCatalog.jsw');
        const engine = await import('../../backend/bookingEngine.jsw');
        const realCat = pricing.getPublicPricingCatalog;
        const realItem = engine.getVehicleCategoryDetails;
        const realFleet = engine.getFleetModelsPreview;
        pricing.getPublicPricingCatalog = (...a) => { calls.catalogue += 1; return realCat(...a); };
        engine.getVehicleCategoryDetails = (...a) => { calls.category += 1; return realItem(...a); };
        engine.getFleetModelsPreview = (...a) => { calls.fleet += 1; return realFleet(...a); };
      },
    });
    await runLadder();

    ctx.wixLocation.__emitChange({ path: ['options'] });
    await runLadder();

    expect(calls).toEqual({ catalogue: 2, category: 2, fleet: 2 });
    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(10);
  });

  test('the change handler is registered exactly once', async () => {
    await boot();

    expect(ctx.wixLocation.__changeHandlerCount()).toBe(1);
  });

  test.each([
    ['the category', 'getVehicleCategoryDetails', 'vehicle-category-data',
      { categoryCode: 'STALE' }, (p) => p.item?.categoryCode === 'STALE'],
    ['the fleet models', 'getFleetModelsPreview', 'fleet-models-data',
      { category: 'STALE', items: [{ model: 'Stale Car' }] }, (p) => p.category === 'STALE'],
  ])('a %s fetch in flight across a route change does not fill the new cache', async (_label, fn, type, staleValue, isStale) => {
    // Unlike the categories page, every cache here re-checks the epoch when its
    // own fetch resolves, so a slow answer from the category the visitor has
    // left cannot become the answer for the one they moved to.
    let calls = 0;
    let pending = null;
    await boot({
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        const real = engine[fn];
        engine[fn] = (...a) => {
          calls += 1;
          if (calls !== 2) return real(...a);
          return new Promise((resolve) => { pending = resolve; });
        };
      },
    });
    await runLadder();

    ctx.wixLocation.__emitChange({ path: ['options'] });
    jest.advanceTimersByTime(RUNGS[0]);
    await flush();
    expect(pending).toBeInstanceOf(Function);

    ctx.wixLocation.__emitChange({ path: ['options'] });
    pending(staleValue);
    await flush();
    await runLadder();

    expect(of(type).some(isStale)).toBe(false);
  });

  test('a catalogue fetch in flight across a route change does not fill the new cache', async () => {
    let calls = 0;
    let pending = null;
    await boot({
      async beforeStart() {
        const pricing = await import('../../backend/pricingCatalog.jsw');
        const real = pricing.getPublicPricingCatalog;
        pricing.getPublicPricingCatalog = (...a) => {
          calls += 1;
          if (calls !== 2) return real(...a);
          return new Promise((resolve) => { pending = resolve; });
        };
      },
    });
    await runLadder();

    ctx.wixLocation.__emitChange({ path: ['options'] });
    jest.advanceTimersByTime(RUNGS[0]);
    await flush();
    expect(pending).toBeInstanceOf(Function);

    ctx.wixLocation.__emitChange({ path: ['options'] });
    pending({ insurancePlans: [{ key: 'stale' }] });
    await flush();
    await runLadder();

    expect(of(BRIDGE_TYPES.PRICING).some((p) => p.catalog?.insurancePlans?.[0]?.key === 'stale')).toBe(false);
  });
});

describe('when a backend fails', () => {
  test('a failing category is reported as a null item and logged', async () => {
    await boot({
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.getVehicleCategoryDetails = () => Promise.reject(new Error('categories offline'));
      },
    });
    await runLadder();

    expect(last('vehicle-category-data').item).toBeNull();
    expect(errors).toHaveBeenCalledWith('Options category load failed', expect.any(Error));
    // The other two are unaffected: the three fetches are independent.
    expect(last(BRIDGE_TYPES.PRICING).catalog).not.toBeNull();
    expect(last('fleet-models-data').items).toHaveLength(2);
  });

  test('a failing fleet preview still answers with the category and an empty list', async () => {
    await boot({
      query: { category: 'SUV' },
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.getFleetModelsPreview = () => Promise.reject(new Error('fleet offline'));
      },
    });
    await runLadder();

    // The frame renders a heading from `category`, so an empty payload would
    // leave it blank rather than showing "no models in this category".
    expect(last('fleet-models-data')).toEqual({
      type: 'fleet-models-data', category: 'SUV', items: [],
    });
    expect(errors).toHaveBeenCalledWith('Options fleet models load failed', expect.any(Error));
  });

  test('a fleet preview that answers with nothing is filled in from the query', async () => {
    await boot({
      query: { category: 'SUV' },
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.getFleetModelsPreview = () => Promise.resolve(null);
      },
    });
    await runLadder();

    expect(last('fleet-models-data')).toEqual({
      type: 'fleet-models-data', category: 'SUV', items: [],
    });
  });

  test('a failing catalogue is reported as null and logged', async () => {
    await boot({
      async beforeStart() {
        const pricing = await import('../../backend/pricingCatalog.jsw');
        pricing.getPublicPricingCatalog = () => Promise.reject(new Error('catalogue offline'));
      },
    });
    await runLadder();

    expect(last(BRIDGE_TYPES.PRICING).catalog).toBeNull();
    expect(errors).toHaveBeenCalledWith('Options pricing catalog load failed', expect.any(Error));
    expect(last('vehicle-category-data').item).not.toBeNull();
  });

  test('a failure is not cached, so the next rung tries again', async () => {
    let calls = 0;
    await boot({
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        const real = engine.getVehicleCategoryDetails;
        engine.getVehicleCategoryDetails = (...a) => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error('offline')) : real(...a);
        };
      },
    });

    jest.advanceTimersByTime(RUNGS[0]);
    await flush();

    expect(calls).toBe(2);
    expect(last('vehicle-category-data').item).toMatchObject({ categoryCode: 'ECO' });
  });
});

describe('messages from the frame', () => {
  beforeEach(async () => {
    await boot();
    await runLadder();
  });

  test.each([
    [BRIDGE_TYPES.REQUEST_CONTEXT, BRIDGE_TYPES.CONTEXT],
    [BRIDGE_TYPES.REQUEST_PRICING, BRIDGE_TYPES.PRICING],
    ['request-vehicle-category-data', 'vehicle-category-data'],
    ['request-fleet-models-data', 'fleet-models-data'],
  ])('%s is answered with %s', async (request, reply) => {
    await send({ type: request });
    await flush();

    expect(of(reply)).toHaveLength(6);
  });

  test('answering one request does not send the others', async () => {
    await send({ type: 'request-fleet-models-data' });
    await flush();

    expect(of('fleet-models-data')).toHaveLength(6);
    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(5);
    expect(of('vehicle-category-data')).toHaveLength(5);
  });

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

    expect(errors).toHaveBeenCalledWith('options navigation failed', expect.any(Error));
  });

  test('a message from an untrusted origin reaches nothing', async () => {
    const before = html.posted.length;
    await send({ type: BRIDGE_TYPES.REQUEST_CONTEXT }, 'https://evil.example');
    await send({ type: BRIDGE_TYPES.WIX_NAV, path: '/evil' }, 'https://evil.example');

    expect(html.posted.length).toBe(before);
    expect(navigatedTo()).toEqual([]);
  });

  test('an origin-less message is accepted', async () => {
    await send({ type: BRIDGE_TYPES.REQUEST_CONTEXT }, '');

    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(6);
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

  test('the window answers all four requests and navigates', async () => {
    await toWindow({ type: BRIDGE_TYPES.REQUEST_CONTEXT });
    await toWindow({ type: BRIDGE_TYPES.REQUEST_PRICING });
    await toWindow({ type: 'request-vehicle-category-data' });
    await toWindow({ type: 'request-fleet-models-data' });
    await toWindow({ type: BRIDGE_TYPES.WIX_NAV, path: '/booking' });

    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(6);
    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(6);
    expect(of('vehicle-category-data')).toHaveLength(6);
    expect(of('fleet-models-data')).toHaveLength(6);
    expect(navigatedTo()).toEqual(['/booking']);
  });

  test('an untrusted window origin is refused', async () => {
    await toWindow({ type: BRIDGE_TYPES.REQUEST_PRICING }, 'https://evil.example');

    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(5);
  });

  test('a payload that will not parse is dropped', async () => {
    const before = html.posted.length;
    await toWindow('{ not json');
    await toWindow(null);

    expect(html.posted.length).toBe(before);
  });
});
