import { bootPageController, createComponent } from '../../../test/helpers/bootPageController.js';
import { BRIDGE_TYPES } from '../../public/bridgeUtils.js';

// The booking confirmation page. Public — no session guard — and its whole job
// is to keep an embedded frame supplied with the booking context and the
// pricing catalogue.
//
// The interesting part is the delivery strategy: the frame may not have loaded
// its listener yet when the page is ready, so the controller fires the same two
// payloads four times on a 100/300/800/1800ms ladder and then again on every
// client-side route change. That is a lot of redundant traffic to pin, and the
// count is the point — dropping a rung is invisible in manual QA and shows up
// only as an occasionally blank confirmation screen.

const COMP = '#html1';
const ALT = '#successHtml';
const TRUSTED = 'https://editor.wix.com';
const URL = 'https://diamond.example/success';

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

async function boot({ extras = {}, bare = false, query = {}, component = null } = {}) {
  html = component || createComponent(COMP);
  ctx = await bootPageController({
    importer: () => import('../Success.tk6s9.js'),
    components: bare ? {} : { [COMP]: html, ...extras },
    seed: seed(),
    query,
    url: URL,
    path: ['success'],
  });
  return ctx;
}

/** Lets queued promise jobs run; the timers are fake, the microtasks are not. */
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
const runResends = async () => { jest.advanceTimersByTime(2000); await flush(); };
const send = (msg, origin = TRUSTED) => html.emitMessage({ origin, data: msg });
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
  test('nothing is posted until the first rung of the ladder comes due', async () => {
    await boot();
    // One millisecond short of the first rung. Checking only at zero would not
    // notice a rung rescheduled to fire immediately.
    jest.advanceTimersByTime(99);
    await flush();

    expect(html.posted).toEqual([]);
  });

  test('the context and the catalogue are each delivered four times', async () => {
    await boot();
    await runResends();

    expect(contexts()).toHaveLength(4);
    expect(catalogs()).toHaveLength(4);
  });

  test.each([[100, 1], [300, 2], [800, 3], [1800, 4]])(
    'by %sms the frame has had %s attempts',
    async (elapsed, attempts) => {
      await boot();
      jest.advanceTimersByTime(elapsed);
      await flush();

      expect(contexts()).toHaveLength(attempts);
    },
  );

  test('the context carries the page URL, path and query', async () => {
    await boot({ query: { bookingId: 'BK-1' } });
    await runResends();

    expect(contexts()[0]).toMatchObject({
      url: URL,
      path: ['success'],
      query: { bookingId: 'BK-1' },
    });
  });

  test('a sensitive query key is blanked before it reaches the frame', async () => {
    await boot({ query: { email: 'guest@example.com', bookingId: 'BK-1' } });
    await runResends();

    expect(contexts()[0].query).toEqual({ email: '', bookingId: 'BK-1' });
  });

  test('the catalogue reaches the frame with the CMS rows in it', async () => {
    await boot();
    await runResends();

    expect(catalogs()[0].catalog).toMatchObject({
      insurancePlans: [expect.objectContaining({ key: 'cdw', pricePerDay: 12 })],
      pickupLocations: [expect.objectContaining({ key: 'ath' })],
    });
  });

  test('the fallback component id is used when the first is absent', async () => {
    const alt = createComponent(ALT);
    ctx = await bootPageController({
      importer: () => import('../Success.tk6s9.js'),
      components: { [ALT]: alt },
      seed: seed(),
      url: URL,
      path: ['success'],
    });
    html = alt;
    await runResends();

    expect(contexts()).toHaveLength(4);
  });

  test('the named candidates outrank whatever HtmlComponent happens to be first', async () => {
    // resolveHtmlComponent falls back to `$w('HtmlComponent')` and takes the
    // first one it finds, so the candidate list only earns its keep when the
    // page carries more than one frame — as here, where an unrelated one is
    // declared ahead of the real target.
    const stray = createComponent('#marketingHtml');
    const alt = createComponent(ALT);
    ctx = await bootPageController({
      importer: () => import('../Success.tk6s9.js'),
      components: { '#marketingHtml': stray, [ALT]: alt },
      seed: seed(),
      url: URL,
      path: ['success'],
    });
    html = alt;
    await runResends();

    expect(contexts()).toHaveLength(4);
    expect(stray.posted).toEqual([]);
  });

  test('a page with no frame at all logs and stops', async () => {
    await boot({ bare: true });
    jest.advanceTimersByTime(2000);
    await flush();

    expect(errors).toHaveBeenCalledWith('Success HTML component not found');
    expect(ctx.wixLocation.__changeHandlerCount()).toBe(0);
  });

  test('a component that refuses the message binding still gets its payloads', async () => {
    const stubborn = createComponent(COMP, { onMessage() { throw new Error('already bound'); } });
    await boot({ component: stubborn });
    await runResends();

    expect(errors).toHaveBeenCalledWith('Bind success html onMessage failed', expect.any(Error));
    expect(contexts()).toHaveLength(4);
  });
});

describe('re-broadcasting on navigation', () => {
  test('a client-side route change replays the whole ladder', async () => {
    await boot();
    await runResends();
    expect(contexts()).toHaveLength(4);

    ctx.wixLocation.__emitChange({ path: ['success', 'again'] });
    await runResends();

    expect(contexts()).toHaveLength(8);
  });

  test('the change handler is registered exactly once', async () => {
    await boot();

    expect(ctx.wixLocation.__changeHandlerCount()).toBe(1);
  });
});

describe('messages from the frame', () => {
  beforeEach(async () => {
    await boot();
    await runResends();
  });

  test('a context request is answered', async () => {
    await send({ type: BRIDGE_TYPES.REQUEST_CONTEXT });

    expect(contexts()).toHaveLength(5);
  });

  test('a pricing request is answered', async () => {
    await send({ type: BRIDGE_TYPES.REQUEST_PRICING });
    await flush();

    expect(catalogs()).toHaveLength(5);
  });

  test('a message from an untrusted origin is ignored', async () => {
    await send({ type: BRIDGE_TYPES.REQUEST_CONTEXT }, 'https://evil.example');

    expect(contexts()).toHaveLength(4);
  });

  test('an origin-less message is accepted', async () => {
    await send({ type: BRIDGE_TYPES.REQUEST_CONTEXT }, '');

    expect(contexts()).toHaveLength(5);
  });

  test('an unparseable payload is ignored', async () => {
    await send('{ not json');
    await send(null);

    expect(contexts()).toHaveLength(4);
  });

  test('an unrecognised message type does nothing', async () => {
    await send({ type: 'something-else' });

    expect(contexts()).toHaveLength(4);
    expect(catalogs()).toHaveLength(4);
  });

  test('a navigation request is followed', async () => {
    await send({ type: BRIDGE_TYPES.WIX_NAV, path: '/booking' });

    expect(navigatedTo()).toEqual(['/booking']);
  });

  test('a navigation request with no path goes nowhere', async () => {
    await send({ type: BRIDGE_TYPES.WIX_NAV });
    await send({ type: BRIDGE_TYPES.WIX_NAV, path: '' });

    expect(navigatedTo()).toEqual([]);
  });

  // Mutation survivors on this file, all equivalent and left alone:
  //
  // - The empty-path check is written twice — once at each call site as
  //   `&& data.path`, once inside `go` as `if (!path) return;`. Deleting either
  //   copy alone is undetectable; deleting both at once is caught here (it
  //   navigates to the literal string 'undefined'), so the pair is load-bearing
  //   even though neither half is.
  // - Replacing `if (!data) return;` with `|| {}` changes nothing: an empty
  //   object has no `type`, so it falls past every branch to the same nothing.
  // - `catalog: catalog || null` never sees undefined — ensurePricingCatalog
  //   normalises to null on both the success and the failure path.

  test('a navigation that throws is logged rather than propagated', async () => {
    ctx.wixLocation.to.mockImplementation(() => { throw new Error('blocked'); });

    await send({ type: BRIDGE_TYPES.WIX_NAV, path: '/booking' });

    expect(errors).toHaveBeenCalledWith('Success navigation failed', expect.any(Error));
  });
});

describe('messages posted to the window', () => {
  beforeEach(async () => {
    await boot();
    await runResends();
  });

  test('the window carries a navigation request too', async () => {
    await ctx.env.emitWindowMessage({ origin: TRUSTED, data: { type: BRIDGE_TYPES.WIX_NAV, path: '/fleet' } });

    expect(navigatedTo()).toEqual(['/fleet']);
  });

  test('an untrusted window origin is refused', async () => {
    await ctx.env.emitWindowMessage({ origin: 'https://evil.example', data: { type: BRIDGE_TYPES.WIX_NAV, path: '/fleet' } });

    expect(navigatedTo()).toEqual([]);
  });

  test('the window listener only navigates — context and pricing requests are ignored there', async () => {
    await ctx.env.emitWindowMessage({ origin: TRUSTED, data: { type: BRIDGE_TYPES.REQUEST_CONTEXT } });
    await ctx.env.emitWindowMessage({ origin: TRUSTED, data: null });
    await flush();

    expect(contexts()).toHaveLength(4);
    expect(catalogs()).toHaveLength(4);
  });
});

describe('the catalogue cache', () => {
  test('the backend is asked once no matter how many rungs and requests follow', async () => {
    await boot();
    const pricing = await import('../../backend/pricingCatalog.jsw');
    const original = pricing.getPublicPricingCatalog;
    const spy = jest.fn(original);
    pricing.getPublicPricingCatalog = spy;
    try {
      await runResends();
      await send({ type: BRIDGE_TYPES.REQUEST_PRICING });
      await flush();
    } finally {
      pricing.getPublicPricingCatalog = original;
    }

    // Four ladder rungs plus an explicit request, and one call: the first
    // resolution fills the module-level cache and everything after reads it.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(catalogs()).toHaveLength(5);
  });

  test('two requests in the same tick share one backend call', async () => {
    // The second guard in ensurePricingCatalog: a request that arrives while a
    // fetch is still in flight joins it instead of starting a second one.
    await boot();
    const pricing = await import('../../backend/pricingCatalog.jsw');
    const original = pricing.getPublicPricingCatalog;
    const spy = jest.fn(original);
    pricing.getPublicPricingCatalog = spy;
    try {
      await send({ type: BRIDGE_TYPES.REQUEST_PRICING });
      await send({ type: BRIDGE_TYPES.REQUEST_PRICING });
      await flush();
    } finally {
      pricing.getPublicPricingCatalog = original;
    }

    expect(spy).toHaveBeenCalledTimes(1);
    expect(catalogs()).toHaveLength(2);
  });

  test('a failing catalogue is posted as null rather than left unanswered', async () => {
    await boot();
    const pricing = await import('../../backend/pricingCatalog.jsw');
    const original = pricing.getPublicPricingCatalog;
    pricing.getPublicPricingCatalog = () => Promise.reject(new Error('catalogue offline'));
    try {
      await runResends();
    } finally {
      pricing.getPublicPricingCatalog = original;
    }

    expect(catalogs()).toHaveLength(4);
    expect(catalogs().every((p) => p.catalog === null)).toBe(true);
    expect(warns).toHaveBeenCalledWith('Success pricing catalog unavailable', expect.any(Error));
  });

  test('a failure is not cached, so the next request tries the backend again', async () => {
    await boot();
    const pricing = await import('../../backend/pricingCatalog.jsw');
    const original = pricing.getPublicPricingCatalog;
    let calls = 0;
    pricing.getPublicPricingCatalog = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('offline')) : original();
    };
    try {
      jest.advanceTimersByTime(100);
      await flush();
      expect(catalogs()[0].catalog).toBeNull();

      jest.advanceTimersByTime(200);
      await flush();
    } finally {
      pricing.getPublicPricingCatalog = original;
    }

    expect(calls).toBe(2);
    expect(catalogs()[1].catalog).not.toBeNull();
  });
});
