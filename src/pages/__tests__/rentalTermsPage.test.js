import { bootPageController, createComponent } from '../../../test/helpers/bootPageController.js';
import { BRIDGE_TYPES } from '../../public/bridgeUtils.js';

// The rental terms page. Structurally the confirmation page's sibling — public,
// one frame, the same context/catalogue payloads on a resend ladder — with one
// addition that makes it worth its own file: a cache epoch.
//
// A client-side route change here clears the cached catalogue and re-fetches.
// The epoch is what stops the in-flight fetch from the *previous* route
// answering into the new one, and it is the sort of guard that is invisible
// until it is wrong.

const COMP = '#termsHtml';
const TRUSTED = 'https://editor.wix.com';
const URL = 'https://diamond.example/rental-terms';

const seed = () => ({
  BusinessSettings: [{ _id: 'bs-1', currency: 'EUR' }],
  InsurancePlans: [{ _id: 'i-1', key: 'cdw', label: 'CDW', pricePerDay: 12, active: true }],
  ExtraServices: [{ _id: 'x-1', key: 'gps', label: 'GPS', price: 5, active: true }],
  FeeRules: [{ _id: 'f-1', key: 'night', label: 'Night', ruleType: 'night', amount: 15, active: true }],
  PricingSeasons: [],
  CategoryRateRules: [],
  PickupLocations: [{ _id: 'p-1', key: 'ath', label: 'Athens Airport', active: true }],
});

let ctx;
let html;
let errors;
let warns;

async function boot({ bare = false, query = {}, component = null, extras = {}, beforeStart = null } = {}) {
  html = component || createComponent(COMP);
  ctx = await bootPageController({
    importer: () => import('../Rental Terms.gd1k0.js'),
    components: bare ? {} : { [COMP]: html, ...extras },
    seed: seed(),
    query,
    url: URL,
    path: ['rental-terms'],
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
const runLadder = async () => { jest.advanceTimersByTime(2500); await flush(); };
const send = async (msg, origin = TRUSTED) => { await html.emitMessage({ origin, data: msg }); await flush(); };
const contexts = () => html.postedOfType(BRIDGE_TYPES.CONTEXT);
const catalogs = () => html.postedOfType(BRIDGE_TYPES.PRICING);
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

describe('opening the page', () => {
  test('the catalogue is fetched on ready, before any rung comes due', async () => {
    let calls = 0;
    await boot({
      async beforeStart() {
        const pricing = await import('../../backend/pricingCatalog.jsw');
        const real = pricing.getPublicPricingCatalog;
        pricing.getPublicPricingCatalog = (...args) => { calls += 1; return real(...args); };
      },
    });

    expect(calls).toBe(1);
    expect(html.posted).toEqual([]);
  });

  test('nothing is posted a millisecond before the first rung', async () => {
    await boot();
    jest.advanceTimersByTime(79);
    await flush();

    expect(html.posted).toEqual([]);
  });

  test.each([[80, 1], [260, 2], [700, 3], [1400, 4], [2400, 5]])(
    'by %sms the frame has had %s attempts',
    async (elapsed, attempts) => {
      await boot();
      jest.advanceTimersByTime(elapsed);
      await flush();

      expect(contexts()).toHaveLength(attempts);
      expect(catalogs()).toHaveLength(attempts);
    },
  );

  test('the context carries the page URL, path and query', async () => {
    await boot({ query: { plan: 'cdw' } });
    await runLadder();

    expect(contexts()[0]).toMatchObject({ url: URL, path: ['rental-terms'], query: { plan: 'cdw' } });
  });

  test('the catalogue carries the CMS rows', async () => {
    await boot();
    await runLadder();

    expect(catalogs()[0].catalog).toMatchObject({
      insurancePlans: [expect.objectContaining({ key: 'cdw', pricePerDay: 12 })],
    });
  });

  test('a page with no frame logs and stops', async () => {
    await boot({ bare: true });
    await runLadder();

    expect(errors).toHaveBeenCalledWith(
      `Rental terms HTML component not found or wrong id. Expected ${COMP}`,
    );
    expect(ctx.wixLocation.__changeHandlerCount()).toBe(0);
  });

  test('a frame that refuses the message binding still gets its payloads', async () => {
    const stubborn = createComponent(COMP, { onMessage() { throw new Error('already bound'); } });
    await boot({ component: stubborn });
    await runLadder();

    expect(errors).toHaveBeenCalledWith('Bind rental terms html onMessage failed', expect.any(Error));
    expect(contexts()).toHaveLength(5);
  });

  test('the named component id outranks whatever HtmlComponent happens to be first', async () => {
    const stray = createComponent('#marketingHtml');
    html = createComponent(COMP);
    ctx = await bootPageController({
      importer: () => import('../Rental Terms.gd1k0.js'),
      components: { '#marketingHtml': stray, [COMP]: html },
      seed: seed(),
      url: URL,
      path: ['rental-terms'],
    });
    await runLadder();

    expect(contexts()).toHaveLength(5);
    expect(stray.posted).toEqual([]);
  });
});

describe('a client-side route change', () => {
  test('replays the ladder and re-fetches the catalogue', async () => {
    let calls = 0;
    await boot({
      async beforeStart() {
        const pricing = await import('../../backend/pricingCatalog.jsw');
        const real = pricing.getPublicPricingCatalog;
        pricing.getPublicPricingCatalog = (...args) => { calls += 1; return real(...args); };
      },
    });
    await runLadder();
    expect(calls).toBe(1);

    ctx.wixLocation.__emitChange({ path: ['rental-terms', 'insurance'] });
    await runLadder();

    expect(contexts()).toHaveLength(10);
    // The cache was cleared, so the catalogue was asked for again rather than
    // replayed from the previous route.
    expect(calls).toBe(2);
  });

  test('the change handler is registered exactly once', async () => {
    await boot();

    expect(ctx.wixLocation.__changeHandlerCount()).toBe(1);
  });

  test('a fetch still in flight when the route changes again does not fill the new cache', async () => {
    // The epoch guard, which is the only thing on this page that cannot be
    // reached by ordinary use. A route change clears the cache and re-fetches;
    // if the route changes a second time while that fetch is still out, the
    // answer belongs to a page that is already gone and must not be cached for
    // the one now on screen.
    const pending = [];
    let calls = 0;
    await boot({
      async beforeStart() {
        const pricing = await import('../../backend/pricingCatalog.jsw');
        const real = pricing.getPublicPricingCatalog;
        pricing.getPublicPricingCatalog = (...args) => {
          calls += 1;
          // Only the fetch belonging to the first route change is held open.
          if (calls === 2) return new Promise((resolve) => { pending.push(() => resolve({ stale: true })); });
          return real(...args);
        };
      },
    });
    await runLadder();
    expect(calls).toBe(1);

    ctx.wixLocation.__emitChange({ path: ['rental-terms', 'insurance'] });
    jest.advanceTimersByTime(80);
    await flush();
    expect(calls).toBe(2);

    ctx.wixLocation.__emitChange({ path: ['rental-terms', 'excess'] });
    pending[0]();
    await flush();
    await runLadder();

    expect(calls).toBe(3);
    expect(catalogs().every((p) => p.catalog?.stale !== true)).toBe(true);
    expect(catalogs().pop().catalog).toMatchObject({
      insurancePlans: [expect.objectContaining({ key: 'cdw' })],
    });
  });
});

describe('messages from the frame', () => {
  beforeEach(async () => {
    await boot();
    await runLadder();
  });

  test('a context request is answered', async () => {
    await send({ type: BRIDGE_TYPES.REQUEST_CONTEXT });

    expect(contexts()).toHaveLength(6);
    expect(catalogs()).toHaveLength(5);
  });

  test('a pricing request is answered', async () => {
    await send({ type: BRIDGE_TYPES.REQUEST_PRICING });

    expect(catalogs()).toHaveLength(6);
    expect(contexts()).toHaveLength(5);
  });

  test('a navigation request is followed', async () => {
    await send({ type: BRIDGE_TYPES.WIX_NAV, path: '/booking' });

    expect(navigatedTo()).toEqual(['/booking']);
  });

  test('a pathless navigation request goes nowhere', async () => {
    await send({ type: BRIDGE_TYPES.WIX_NAV });

    expect(navigatedTo()).toEqual([]);
  });

  // Two mutation survivors on this file, both equivalent, both shared with the
  // confirmation page:
  //
  // - The empty-path check is written twice, at the call sites as `&& data.path`
  //   and inside `go` as `if (!path) return;`. Deleting either copy alone is
  //   undetectable.
  // - `catalog: catalog || null` never sees undefined; ensurePricingCatalog
  //   normalises to null on the success, failure and stale-epoch paths alike.

  test('a navigation that throws is logged rather than propagated', async () => {
    ctx.wixLocation.to.mockImplementation(() => { throw new Error('blocked'); });

    await send({ type: BRIDGE_TYPES.WIX_NAV, path: '/booking' });

    expect(errors).toHaveBeenCalledWith('rental-terms navigation failed', expect.any(Error));
  });

  test('an untrusted origin is refused', async () => {
    await send({ type: BRIDGE_TYPES.REQUEST_CONTEXT }, 'https://evil.example');

    expect(contexts()).toHaveLength(5);
  });

  test('an origin-less message is accepted', async () => {
    await send({ type: BRIDGE_TYPES.REQUEST_CONTEXT }, '');

    expect(contexts()).toHaveLength(6);
  });

  test('an unparseable payload and an unknown type do nothing', async () => {
    const before = html.posted.length;
    await send('{ not json');
    await send(null);
    await send({ type: 'something-else' });

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

  test('the window answers context and pricing requests and navigates', async () => {
    await toWindow({ type: BRIDGE_TYPES.REQUEST_CONTEXT });
    await toWindow({ type: BRIDGE_TYPES.REQUEST_PRICING });
    await toWindow({ type: BRIDGE_TYPES.WIX_NAV, path: '/fleet' });

    expect(contexts()).toHaveLength(6);
    expect(catalogs()).toHaveLength(6);
    expect(navigatedTo()).toEqual(['/fleet']);
  });

  test('an untrusted window origin is refused', async () => {
    await toWindow({ type: BRIDGE_TYPES.REQUEST_PRICING }, 'https://evil.example');

    expect(catalogs()).toHaveLength(5);
  });

  test('a payload that will not parse is dropped', async () => {
    const before = html.posted.length;
    await toWindow('{ not json');
    await toWindow(null);

    expect(html.posted.length).toBe(before);
  });
});

describe('the catalogue cache', () => {
  test('one fetch serves the whole ladder and every later request', async () => {
    let calls = 0;
    await boot({
      async beforeStart() {
        const pricing = await import('../../backend/pricingCatalog.jsw');
        const real = pricing.getPublicPricingCatalog;
        pricing.getPublicPricingCatalog = (...args) => { calls += 1; return real(...args); };
      },
    });
    await runLadder();
    await send({ type: BRIDGE_TYPES.REQUEST_PRICING });

    expect(calls).toBe(1);
    expect(catalogs()).toHaveLength(6);
  });

  test('a failing catalogue is posted as null rather than left unanswered', async () => {
    await boot({
      beforeStart: stub('../../backend/pricingCatalog.jsw', 'getPublicPricingCatalog',
        () => Promise.reject(new Error('catalogue offline'))),
    });
    await runLadder();

    expect(catalogs()).toHaveLength(5);
    expect(catalogs().every((p) => p.catalog === null)).toBe(true);
    expect(warns).toHaveBeenCalledWith('Rental terms pricing catalog unavailable', expect.any(Error));
  });

  test('a failure is not cached, and the two requests after it share one retry', async () => {
    let calls = 0;
    let failing = true;
    await boot({
      async beforeStart() {
        const pricing = await import('../../backend/pricingCatalog.jsw');
        const real = pricing.getPublicPricingCatalog;
        pricing.getPublicPricingCatalog = (...args) => {
          calls += 1;
          return failing ? Promise.reject(new Error('offline')) : real(...args);
        };
      },
    });
    // The ready fetch failed; the first rung tried again and failed too, which
    // is what makes the point — nothing was cached from either attempt.
    jest.advanceTimersByTime(80);
    await flush();
    expect(calls).toBe(2);
    expect(catalogs()[0].catalog).toBeNull();
    failing = false;

    // Both handlers have to run in one synchronous turn for the in-flight
    // promise, rather than the filled cache, to be what the second one finds.
    const first = html.emitMessage({ origin: TRUSTED, data: { type: BRIDGE_TYPES.REQUEST_PRICING } });
    const second = html.emitMessage({ origin: TRUSTED, data: { type: BRIDGE_TYPES.REQUEST_PRICING } });
    await Promise.all([first, second]);
    await flush();

    expect(calls).toBe(3);
    expect(catalogs()[1].catalog).not.toBeNull();
    expect(catalogs()[2].catalog).not.toBeNull();
  });
});
