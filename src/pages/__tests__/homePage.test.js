import { bootPageController, createComponent } from '../../../test/helpers/bootPageController.js';
import { BRIDGE_TYPES } from '../../public/bridgeUtils.js';

// The public home page. Like the confirmation page it feeds an embedded frame,
// but it carries three payloads rather than one — the pricing catalogue, the
// pickup locations and the vehicle categories — and it fetches them from two
// different backends with two independent caches.
//
// Its delivery strategy is a handshake rather than a ladder: everything is sent
// once on ready, and if the frame has not answered with 'home-ready' within
// 1200ms it is all sent again. That retry is the safety net for a slow frame,
// and it stops the moment the frame speaks.

const COMP = '#bpage1';
const TRUSTED = 'https://editor.wix.com';
const URL = 'https://diamond.example/home';
const PICKUP = 'pickup-locations-data';
const CATEGORIES = 'vehicle-categories-data';

const seed = () => ({
  BusinessSettings: [{ _id: 'bs-1', currency: 'EUR' }],
  InsurancePlans: [{ _id: 'i-1', key: 'cdw', label: 'CDW', pricePerDay: 12, active: true }],
  ExtraServices: [{ _id: 'x-1', key: 'gps', label: 'GPS', price: 5, active: true }],
  FeeRules: [{ _id: 'f-1', key: 'night', label: 'Night', ruleType: 'night', amount: 15, active: true }],
  PricingSeasons: [],
  CategoryRateRules: [],
  PickupLocations: [{ _id: 'p-1', key: 'ath', label: 'Athens Airport', active: true }],
  VehiclesNew: [
    { _id: 'v-1', category: 'ECO', title: 'Fiat Panda', price: 30, active: true },
    { _id: 'v-2', category: 'SUV', title: 'Jeep Renegade', price: 70, active: true },
    { _id: 'v-3', category: 'OLD', title: 'Retired', price: 10, active: false },
  ],
});

let ctx;
let html;
let errors;
let warns;

async function boot({ bare = false, query = {}, component = null, extras = {}, beforeStart = null } = {}) {
  html = component || createComponent(COMP);
  ctx = await bootPageController({
    importer: () => import('../Home Page.l2zf7.js'),
    components: bare ? {} : { [COMP]: html, ...extras },
    seed: seed(),
    query,
    url: URL,
    path: ['home'],
    beforeStart,
  });
  await flush();
  return ctx;
}

/** Replaces a named export on a backend module for the life of one boot. */
function stub(specifier, name, impl) {
  return async () => {
    const mod = await import(specifier);
    mod[name] = impl;
  };
}

const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
const send = (msg, origin = TRUSTED) => html.emitMessage({ origin, data: msg });
const of = (type) => html.postedOfType(type);
const navigatedTo = () => ctx.wixLocation.to.mock.calls.map((c) => c[0]);

beforeEach(() => {
  errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  warns = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  if (ctx) await ctx.teardown();
  ctx = null;
  html = null;
  errors.mockRestore();
  warns.mockRestore();
});

describe('the first sync', () => {
  test('all four payloads go out on ready', async () => {
    await boot();

    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(1);
    expect(of(PICKUP)).toHaveLength(1);
    expect(of(CATEGORIES)).toHaveLength(1);
    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(1);
  });

  test('the catalogue and the pickup locations come from the CMS', async () => {
    await boot();

    expect(of(BRIDGE_TYPES.PRICING)[0].catalog).toMatchObject({
      insurancePlans: [expect.objectContaining({ key: 'cdw', pricePerDay: 12 })],
    });
    expect(of(PICKUP)[0].items).toEqual([expect.objectContaining({ key: 'ath' })]);
  });

  test('the categories are listed cheapest first, with inactive rows left out', async () => {
    await boot();

    const items = of(CATEGORIES)[0].items;
    expect(items.map((i) => i.categoryCode)).toEqual(['ECO', 'SUV']);
  });

  test('the context carries the page URL, path and query', async () => {
    await boot({ query: { pickup: 'ath' } });

    expect(of(BRIDGE_TYPES.CONTEXT)[0]).toMatchObject({ url: URL, path: ['home'], query: { pickup: 'ath' } });
  });

  test('a page with no frame still runs the sync — it just has nowhere to post', async () => {
    // Unlike the confirmation page, this controller has no early return when the
    // frame is missing: it does all the fetching and drops the results.
    await boot({ bare: true });

    expect(errors).not.toHaveBeenCalled();
  });

  test('the named component id outranks whatever HtmlComponent happens to be first', async () => {
    // resolveHtmlComponent falls back to `$w('HtmlComponent')` and takes the
    // first frame it finds, so #bpage1 only earns its keep on a page carrying
    // more than one — as here, where an unrelated frame is declared ahead of it.
    const stray = createComponent('#marketingHtml');
    await boot({ extras: {}, component: null, bare: false });
    await ctx.teardown();
    html = createComponent(COMP);
    ctx = await bootPageController({
      importer: () => import('../Home Page.l2zf7.js'),
      components: { '#marketingHtml': stray, [COMP]: html },
      seed: seed(),
      url: URL,
      path: ['home'],
    });
    await flush();

    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(1);
    expect(stray.posted).toEqual([]);
  });

  test('a component that refuses the message binding still receives its payloads', async () => {
    const stubborn = createComponent(COMP, { onMessage() { throw new Error('already bound'); } });
    await boot({ component: stubborn });

    expect(errors).toHaveBeenCalledWith('Bind home html onMessage failed', expect.any(Error));
    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(1);
  });
});

describe('the 1200ms retry', () => {
  test('a frame that never answers gets everything a second time', async () => {
    await boot();
    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(1);

    jest.advanceTimersByTime(1200);
    await flush();

    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(2);
    expect(of(CATEGORIES)).toHaveLength(2);
  });

  test('the retry has not fired a millisecond early', async () => {
    await boot();
    jest.advanceTimersByTime(1199);
    await flush();

    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(1);
  });

  test.each(['home-ready', 'bridge-ready'])('%s stops the retry', async (type) => {
    await boot();

    await send({ type });
    await flush();
    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(2);

    jest.advanceTimersByTime(1200);
    await flush();

    // Two: the ready sync and the handshake's own. The retry stayed home.
    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(2);
  });

  test('an unrelated message does not count as the handshake', async () => {
    await boot();

    await send({ type: BRIDGE_TYPES.REQUEST_CONTEXT });
    jest.advanceTimersByTime(1200);
    await flush();

    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(2);
  });
});

describe('messages from the frame', () => {
  beforeEach(async () => { await boot(); });

  test('a context request is answered with the context alone', async () => {
    await send({ type: BRIDGE_TYPES.REQUEST_CONTEXT });
    await flush();

    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(2);
    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(1);
  });

  test('a pricing request is answered with the catalogue alone', async () => {
    await send({ type: BRIDGE_TYPES.REQUEST_PRICING });
    await flush();

    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(2);
    expect(of(PICKUP)).toHaveLength(1);
  });

  test('a pickup-locations request is answered from the pricing catalogue', async () => {
    await send({ type: 'request-pickup-locations-data' });
    await flush();

    expect(of(PICKUP)).toHaveLength(2);
    expect(of(PICKUP)[1].items).toEqual([expect.objectContaining({ key: 'ath' })]);
  });

  test('a categories request is answered from the fleet', async () => {
    await send({ type: 'request-vehicle-categories-data' });
    await flush();

    expect(of(CATEGORIES)).toHaveLength(2);
    expect(of(CATEGORIES)[1].items.map((i) => i.categoryCode)).toEqual(['ECO', 'SUV']);
  });

  test('a navigation request is followed', async () => {
    await send({ type: BRIDGE_TYPES.WIX_NAV, path: '/booking' });

    expect(navigatedTo()).toEqual(['/booking']);
  });

  test('a pathless navigation request goes nowhere', async () => {
    await send({ type: BRIDGE_TYPES.WIX_NAV });

    expect(navigatedTo()).toEqual([]);
  });

  // Two mutation survivors on this file, both equivalent:
  //
  // - Replacing `if (!data) return;` in the window listener with `|| {}` is
  //   undetectable — an empty object has no `type`, so it falls past every
  //   branch to the same nothing. (The component branch has the same shape but
  //   is not equivalent there, because a `{}` would still be measured against
  //   the handshake.)
  // - Turning syncData's `Promise.all` into two sequential awaits changes the
  //   concurrency but not one observable byte: the same four payloads go out in
  //   the same order. Nothing here can tell the two apart, and a test that could
  //   would be pinning wall-clock scheduling rather than behaviour.

  test('a navigation that throws is logged rather than propagated', async () => {
    ctx.wixLocation.to.mockImplementation(() => { throw new Error('blocked'); });

    await send({ type: BRIDGE_TYPES.WIX_NAV, path: '/booking' });

    expect(errors).toHaveBeenCalledWith('Home navigation failed', expect.any(Error));
  });

  test('an untrusted origin is refused', async () => {
    await send({ type: BRIDGE_TYPES.REQUEST_CONTEXT }, 'https://evil.example');

    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(1);
  });

  test('an origin-less message is accepted', async () => {
    await send({ type: BRIDGE_TYPES.REQUEST_CONTEXT }, '');

    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(2);
  });

  test('an unparseable payload and an unknown type do nothing', async () => {
    const before = html.posted.length;
    await send('{ not json');
    await send(null);
    await send({ type: 'something-else' });
    await flush();

    expect(html.posted.length).toBe(before);
  });
});

describe('messages posted to the window', () => {
  beforeEach(async () => { await boot(); });

  const toWindow = async (data, origin = TRUSTED) => {
    await ctx.env.emitWindowMessage({ origin, data });
    await flush();
  };

  test('the window answers all four request types', async () => {
    await toWindow({ type: BRIDGE_TYPES.REQUEST_CONTEXT });
    await toWindow({ type: BRIDGE_TYPES.REQUEST_PRICING });
    await toWindow({ type: 'request-pickup-locations-data' });
    await toWindow({ type: 'request-vehicle-categories-data' });

    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(2);
    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(2);
    expect(of(PICKUP)).toHaveLength(2);
    expect(of(CATEGORIES)).toHaveLength(2);
  });

  test('the window carries navigation too', async () => {
    await toWindow({ type: BRIDGE_TYPES.WIX_NAV, path: '/fleet' });

    expect(navigatedTo()).toEqual(['/fleet']);
  });

  test('an untrusted window origin is refused', async () => {
    await toWindow({ type: BRIDGE_TYPES.REQUEST_PRICING }, 'https://evil.example');

    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(1);
  });

  test('a payload that will not parse is dropped', async () => {
    const before = html.posted.length;
    await toWindow('{ not json');
    await toWindow(null);

    expect(html.posted.length).toBe(before);
  });

  test('the window handshake is not wired up — home-ready there does not stop the retry', async () => {
    // Worth stating: the window branch is a subset of the component branch. It
    // answers requests but never sets bridgeReadyAck, so a frame that only ever
    // talks to the window still gets the 1200ms retry.
    await toWindow({ type: 'home-ready' });
    jest.advanceTimersByTime(1200);
    await flush();

    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(2);
  });
});

// One mutation survivor on this file, left alone as equivalent: replacing the
// Promise.all in syncData with two sequential awaits. Both fetches still happen
// and both results still arrive, because each ensure* function swallows its own
// failures — the difference is latency, not behaviour, and no assertion about
// what the frame receives can see it.
describe('the two caches', () => {
  test('neither backend is asked twice once both have answered', async () => {
    let pricingCalls = 0;
    let catsCalls = 0;
    html = createComponent(COMP);
    ctx = await bootPageController({
      importer: () => import('../Home Page.l2zf7.js'),
      components: { [COMP]: html },
      seed: seed(),
      url: URL,
      path: ['home'],
      async beforeStart() {
        const pricing = await import('../../backend/pricingCatalog.jsw');
        const engine = await import('../../backend/bookingEngine.jsw');
        const realPricing = pricing.getPublicPricingCatalog;
        const realCats = engine.getVehicleCategoriesCatalog;
        pricing.getPublicPricingCatalog = (...args) => { pricingCalls += 1; return realPricing(...args); };
        engine.getVehicleCategoriesCatalog = (...args) => { catsCalls += 1; return realCats(...args); };
      },
    });
    await flush();
    expect(pricingCalls).toBe(1);

    jest.advanceTimersByTime(1200);
    await flush();
    await send({ type: BRIDGE_TYPES.REQUEST_PRICING });
    await send({ type: 'request-vehicle-categories-data' });
    await flush();

    // The retry and both explicit requests were all served from the module-level
    // caches — one fetch each for the life of the page.
    expect(pricingCalls).toBe(1);
    expect(catsCalls).toBe(1);
  });

  test('a failing pricing backend is reported as a null catalogue and empty locations', async () => {
    await boot({
      beforeStart: stub('../../backend/pricingCatalog.jsw', 'getPublicPricingCatalog',
        () => Promise.reject(new Error('catalogue offline'))),
    });

    expect(of(BRIDGE_TYPES.PRICING)[0].catalog).toBeNull();
    expect(of(PICKUP)[0].items).toEqual([]);
    expect(warns).toHaveBeenCalledWith('Home pricing catalog unavailable', expect.any(Error));
    // The other half of the page is unaffected — the two fetches are independent.
    expect(of(CATEGORIES)[0].items).toHaveLength(2);
  });

  test('a failing fleet backend is reported as no categories', async () => {
    await boot({
      beforeStart: stub('../../backend/bookingEngine.jsw', 'getVehicleCategoriesCatalog',
        () => Promise.reject(new Error('fleet offline'))),
    });

    expect(of(CATEGORIES)[0].items).toEqual([]);
    expect(warns).toHaveBeenCalledWith('Home categories unavailable', expect.any(Error));
    expect(of(BRIDGE_TYPES.PRICING)[0].catalog).not.toBeNull();
  });

  test('an empty fleet is retried rather than cached', async () => {
    // vehicleCategories caches on `length`, so an empty answer is
    // indistinguishable from never having asked — the next request goes back to
    // the backend. A catalogue with no rows means a fetch on every request.
    let calls = 0;
    await boot({
      beforeStart: stub('../../backend/bookingEngine.jsw', 'getVehicleCategoriesCatalog',
        () => { calls += 1; return Promise.resolve([]); }),
    });
    await send({ type: 'request-vehicle-categories-data' });
    await flush();

    expect(calls).toBe(2);
    expect(of(CATEGORIES)[1].items).toEqual([]);
  });

  test('a pricing failure is not cached, and the retry after it is shared', async () => {
    // Two properties in one, because only a failed first fetch can produce
    // them: the null result must not be cached (or the page never recovers),
    // and the two requests that follow in the same tick must join a single
    // retry rather than each starting their own.
    let calls = 0;
    await boot({
      async beforeStart() {
        const pricing = await import('../../backend/pricingCatalog.jsw');
        const real = pricing.getPublicPricingCatalog;
        pricing.getPublicPricingCatalog = (...args) => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error('offline')) : real(...args);
        };
      },
    });
    expect(of(BRIDGE_TYPES.PRICING)[0].catalog).toBeNull();

    const first = send({ type: BRIDGE_TYPES.REQUEST_PRICING });
    const second = send({ type: BRIDGE_TYPES.REQUEST_PRICING });
    await Promise.all([first, second]);
    await flush();

    expect(calls).toBe(2);
    expect(of(BRIDGE_TYPES.PRICING)[1].catalog).not.toBeNull();
    expect(of(BRIDGE_TYPES.PRICING)[2].catalog).not.toBeNull();
  });

  test('two requests for an uncached fleet share a single fetch', async () => {
    let calls = 0;
    let answer = [];
    await boot({
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.getVehicleCategoriesCatalog = () => { calls += 1; return Promise.resolve(answer); };
      },
    });
    expect(calls).toBe(1);

    // Deliberately not awaited one at a time: awaiting the first send lets its
    // fetch resolve and fill the cache, and then the second request is a cache
    // hit rather than a concurrent one. Both handlers have to run in the same
    // synchronous turn for the in-flight promise to be the thing under test.
    answer = [{ categoryCode: 'ECO', title: 'Panda' }];
    const first = send({ type: 'request-vehicle-categories-data' });
    const second = send({ type: 'request-vehicle-categories-data' });
    await Promise.all([first, second]);
    await flush();

    expect(calls).toBe(2);
    expect(of(CATEGORIES)).toHaveLength(3);
  });

  test('a fleet backend that answers with something other than a list yields no categories', async () => {
    // Array.isArray is the only thing standing between a malformed backend
    // answer and an object being posted to the frame where a list belongs.
    await boot({
      beforeStart: stub('../../backend/bookingEngine.jsw', 'getVehicleCategoriesCatalog',
        () => Promise.resolve({ items: [{ categoryCode: 'ECO' }] })),
    });

    expect(of(CATEGORIES)[0].items).toEqual([]);
  });

  test('two requests in the same tick share one fetch of each backend', async () => {
    let pricingCalls = 0;
    let catsCalls = 0;
    html = createComponent(COMP);
    ctx = await bootPageController({
      importer: () => import('../Home Page.l2zf7.js'),
      components: { [COMP]: html },
      seed: seed(),
      url: URL,
      path: ['home'],
      async beforeStart() {
        const pricing = await import('../../backend/pricingCatalog.jsw');
        const engine = await import('../../backend/bookingEngine.jsw');
        const realPricing = pricing.getPublicPricingCatalog;
        const realCats = engine.getVehicleCategoriesCatalog;
        pricing.getPublicPricingCatalog = (...args) => { pricingCalls += 1; return realPricing(...args); };
        engine.getVehicleCategoriesCatalog = (...args) => { catsCalls += 1; return realCats(...args); };
      },
    });
    // The ready sync is still in flight when the handshake arrives, so the
    // second syncData joins the first one's fetches rather than starting its own.
    await send({ type: 'home-ready' });
    await flush();

    expect(pricingCalls).toBe(1);
    expect(catsCalls).toBe(1);
  });
});
