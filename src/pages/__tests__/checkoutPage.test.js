import { bootPageController, createComponent } from '../../../test/helpers/bootPageController.js';
import { BRIDGE_TYPES } from '../../public/bridgeUtils.js';

// The checkout step: the last screen before a booking exists. It carries three
// caches — the pricing catalogue, the chosen category and the signed-in
// member's details — and the submit that turns all of it into a record.
//
// Worth contrasting with the booking form page, which re-reads the member on
// every request: here the prefill is cached like the other two — but only a
// *successful* read is, because the cache test is `if (memberPrefill)` and a
// signed-out visitor caches as null. So a visitor who signs in mid-checkout is
// picked up on the next request, while a signed-in one is read exactly once.

const COMP = '#bpage4';
const TRUSTED = 'https://editor.wix.com';
const URL = 'https://diamond.example/checkout';
const RUNGS = [80, 260, 700, 1400, 2400];

const MEMBER = {
  loginEmail: 'login@example.com',
  contactDetails: {
    firstName: 'Maria', lastName: 'Pappas',
    emails: ['maria@example.com'], phones: ['+30 210 1111111'],
    addresses: [
      { country: 'GR' },
      { addressLine: '12 Tsimiski', addressLine2: 'Floor 3', city: 'Thessaloniki', country: 'GR', postalCode: '54624' },
    ],
  },
};

const seed = () => ({
  BusinessSettings: [{ _id: 'bs-1', currency: 'EUR' }],
  InsurancePlans: [{ _id: 'i-1', key: 'cdw', label: 'CDW', pricePerDay: 12, active: true }],
  ExtraServices: [],
  FeeRules: [],
  PricingSeasons: [],
  CategoryRateRules: [],
  PickupLocations: [],
  VehiclesNew: [
    { _id: 'cat-1', category: 'ECO', title: 'Economy', price: 30, active: true },
    { _id: 'cat-2', category: 'SUV', title: 'SUV', price: 70, active: true },
  ],
  FleetNew: [],
  BookingsNew: [],
});

let ctx;
let html;
let errors;
let warns;

const withMember = (member) => async () => {
  const members = await import('wix-members-frontend');
  members.currentMember.getMember = () => Promise.resolve(member);
};

async function boot({ bare = false, query = { category: 'ECO' }, component = null, extras = {}, beforeStart = null } = {}) {
  html = component || createComponent(COMP);
  ctx = await bootPageController({
    importer: () => import('../Checkout.c371l.js'),
    components: bare ? {} : { [COMP]: html, ...extras },
    seed: seed(),
    query,
    url: URL,
    path: ['checkout'],
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
  test('nothing is posted before the first rung comes due', async () => {
    await boot();
    jest.advanceTimersByTime(RUNGS[0] - 1);
    await flush();

    expect(html.posted).toEqual([]);
  });

  test('the context, the catalogue and the category each go out five times', async () => {
    await boot();
    await runLadder();

    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(5);
    expect(of(BRIDGE_TYPES.PRICING)).toHaveLength(5);
    expect(of('vehicle-category-data')).toHaveLength(5);
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
    const calls = { catalogue: 0, category: 0, member: 0 };
    await boot({
      async beforeStart() {
        const pricing = await import('../../backend/pricingCatalog.jsw');
        const engine = await import('../../backend/bookingEngine.jsw');
        const members = await import('wix-members-frontend');
        const realCat = pricing.getPublicPricingCatalog;
        const realItem = engine.getVehicleCategoryDetails;
        pricing.getPublicPricingCatalog = (...a) => { calls.catalogue += 1; return realCat(...a); };
        engine.getVehicleCategoryDetails = (...a) => { calls.category += 1; return realItem(...a); };
        members.currentMember.getMember = () => { calls.member += 1; return Promise.resolve(MEMBER); };
      },
    });

    expect(calls).toEqual({ catalogue: 1, category: 1, member: 1 });
    await runLadder();
    expect(calls).toEqual({ catalogue: 1, category: 1, member: 1 });
  });

  test('the context carries the page URL, path and query', async () => {
    await boot({ query: { category: 'SUV' } });
    await runLadder();

    expect(of(BRIDGE_TYPES.CONTEXT)[0]).toMatchObject({
      url: URL, path: ['checkout'], query: { category: 'SUV' },
    });
  });

  test('a page with no frame logs and stops', async () => {
    await boot({ bare: true });
    await runLadder();

    expect(errors).toHaveBeenCalledWith('Checkout HTML component not found');
    expect(ctx.wixLocation.__changeHandlerCount()).toBe(0);
  });

  test('a frame that refuses the binding still gets its payloads', async () => {
    const stubborn = createComponent(COMP, { onMessage() { throw new Error('already bound'); } });
    await boot({ component: stubborn });
    await runLadder();

    expect(errors).toHaveBeenCalledWith('Bind checkout html onMessage failed', expect.any(Error));
    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(5);
  });

  test.each(['#checkoutHtml', '#bookingHtml', '#html1'])('the fallback component id %s is used', async (id) => {
    const stray = createComponent('#marketingHtml');
    const alt = createComponent(id);
    ctx = await bootPageController({
      importer: () => import('../Checkout.c371l.js'),
      components: { '#marketingHtml': stray, [id]: alt },
      seed: seed(),
      query: { category: 'ECO' },
      url: URL,
      path: ['checkout'],
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

describe('the member prefill', () => {
  test('a signed-in member’s details reach the form under both keys', async () => {
    await boot({ beforeStart: withMember(MEMBER) });
    await runLadder();

    const payload = last('member-prefill');
    expect(payload.member).toEqual({
      firstName: 'Maria', lastName: 'Pappas',
      email: 'maria@example.com', phone: '+30 210 1111111',
      address: '12 Tsimiski', address2: 'Floor 3',
      city: 'Thessaloniki', country: 'GR', postalCode: '54624',
    });
    expect(payload.payload).toEqual(payload.member);
  });

  test('the full contact fieldset is requested, not the default one', async () => {
    const seen = [];
    await boot({
      async beforeStart() {
        const members = await import('wix-members-frontend');
        members.currentMember.getMember = (options) => { seen.push(options); return Promise.resolve(MEMBER); };
      },
    });

    expect(seen[0]).toEqual({ fieldsets: ['FULL'] });
  });

  test('the login email stands in when the contact record has none', async () => {
    await boot({ beforeStart: withMember({ loginEmail: 'login@example.com', contactDetails: { firstName: 'Maria' } }) });
    await runLadder();

    expect(last('member-prefill').member).toMatchObject({ email: 'login@example.com', address: '' });
  });

  test('an address with a city but no street counts as the filled-in one', async () => {
    await boot({
      beforeStart: withMember({ contactDetails: { addresses: [{ country: 'GR' }, { city: 'Thessaloniki' }] } }),
    });
    await runLadder();

    expect(last('member-prefill').member).toMatchObject({ city: 'Thessaloniki', address: '' });
  });

  test('the first address is used when none of them look complete', async () => {
    await boot({ beforeStart: withMember({ contactDetails: { addresses: [{ country: 'GR' }, { country: 'CY' }] } }) });
    await runLadder();

    expect(last('member-prefill').member).toMatchObject({ country: 'GR' });
  });

  test('an addresses field that is not a list is ignored rather than indexed', async () => {
    await boot({ beforeStart: withMember({ contactDetails: { firstName: 'Maria', addresses: 'not a list' } }) });
    await runLadder();

    expect(last('member-prefill').member).toMatchObject({ firstName: 'Maria', city: '' });
  });

  test('a signed-out visitor gets no prefill payload at all', async () => {
    await boot();
    await runLadder();

    expect(of('member-prefill')).toEqual([]);
    expect(warns).not.toHaveBeenCalledWith('Checkout member prefill unavailable', expect.anything());
  });

  test('a members API that throws is logged and produces no payload', async () => {
    await boot({
      async beforeStart() {
        const members = await import('wix-members-frontend');
        members.currentMember.getMember = () => Promise.reject(new Error('members offline'));
      },
    });
    await runLadder();

    expect(of('member-prefill')).toEqual([]);
    expect(warns).toHaveBeenCalledWith('Checkout member prefill unavailable', expect.any(Error));
  });

  test('signing in with the page already open is picked up on the next request', async () => {
    // A null prefill is never cached — `if (memberPrefill)` is falsy for it — so
    // the signed-out state is re-read every time rather than remembered.
    let member = null;
    let calls = 0;
    await boot({
      async beforeStart() {
        const members = await import('wix-members-frontend');
        members.currentMember.getMember = () => { calls += 1; return Promise.resolve(member); };
      },
    });
    await runLadder();
    expect(of('member-prefill')).toEqual([]);
    // Two reads, not one: the ready fetch, then a second for the ladder. (All
    // five rungs fire in the same tick under a fake clock and share that one
    // in-flight promise.) A cached null would have made it exactly one.
    expect(calls).toBe(2);

    member = MEMBER;
    await send({ type: 'request-member-prefill' });
    await flush();

    expect(last('member-prefill').member).toMatchObject({ firstName: 'Maria' });
  });

  test('a successful prefill is read once and served from the cache after that', async () => {
    let calls = 0;
    await boot({
      async beforeStart() {
        const members = await import('wix-members-frontend');
        members.currentMember.getMember = () => { calls += 1; return Promise.resolve(MEMBER); };
      },
    });
    await runLadder();
    await send({ type: 'request-member-prefill' });
    await flush();

    expect(calls).toBe(1);
    expect(of('member-prefill')).toHaveLength(RUNGS.length + 1);
    expect(last('member-prefill').member).toMatchObject({ firstName: 'Maria' });
  });
});

describe('submitting the booking', () => {
  test('a form missing required fields is refused and the reason relayed', async () => {
    await boot();

    await send({ type: 'submit-booking', payload: { email: 'guest@example.com' } });
    await flush();

    expect(last('booking-submit-result')).toMatchObject({
      success: false,
      message: 'Λείπουν υποχρεωτικά πεδία.',
    });
  });

  test('a successful booking is relayed with its number and id', async () => {
    await boot({
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.createBooking = () => Promise.resolve({
          success: true, bookingNumber: 'BK-2026-007', _id: 'b-7', message: 'ok',
        });
      },
    });

    await send({ type: 'submit-booking', payload: { email: 'guest@example.com' } });
    await flush();

    expect(last('booking-submit-result')).toEqual({
      type: 'booking-submit-result',
      success: true, bookingNumber: 'BK-2026-007', id: 'b-7', message: 'ok',
    });
  });

  test('an id under the other spelling is still relayed', async () => {
    await boot({
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.createBooking = () => Promise.resolve({ success: true, id: 'b-8' });
      },
    });

    await send({ type: 'submit-booking', payload: {} });
    await flush();

    expect(last('booking-submit-result')).toMatchObject({ id: 'b-8', bookingNumber: '', message: '' });
  });

  test('a backend that throws is reported as a failure carrying its message', async () => {
    await boot({
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.createBooking = () => Promise.reject(new Error('database down'));
      },
    });

    await send({ type: 'submit-booking', payload: {} });
    await flush();

    expect(last('booking-submit-result')).toEqual({
      type: 'booking-submit-result', success: false, message: 'database down',
    });
  });

  test('a thrown value with no message is still reported', async () => {
    await boot({
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.createBooking = () => Promise.reject('just a string');
      },
    });

    await send({ type: 'submit-booking', payload: {} });
    await flush();

    expect(last('booking-submit-result')).toMatchObject({ success: false, message: 'just a string' });
  });

  test('the form payload reaches the backend under either key', async () => {
    const seen = [];
    await boot({
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.createBooking = (payload) => { seen.push(payload); return Promise.resolve({ success: true }); };
      },
    });

    await send({ type: 'submit-booking', payload: { email: 'a@example.com' } });
    await send({ type: 'submit-booking', data: { email: 'b@example.com' } });
    await send({ type: 'submit-booking' });
    await flush();

    expect(seen).toEqual([{ email: 'a@example.com' }, { email: 'b@example.com' }, {}]);
  });
});

describe('a client-side route change', () => {
  test('clears all three caches and re-fetches', async () => {
    const calls = { catalogue: 0, category: 0, member: 0 };
    await boot({
      async beforeStart() {
        const pricing = await import('../../backend/pricingCatalog.jsw');
        const engine = await import('../../backend/bookingEngine.jsw');
        const members = await import('wix-members-frontend');
        const realCat = pricing.getPublicPricingCatalog;
        const realItem = engine.getVehicleCategoryDetails;
        pricing.getPublicPricingCatalog = (...a) => { calls.catalogue += 1; return realCat(...a); };
        engine.getVehicleCategoryDetails = (...a) => { calls.category += 1; return realItem(...a); };
        members.currentMember.getMember = () => { calls.member += 1; return Promise.resolve(MEMBER); };
      },
    });
    await runLadder();

    ctx.wixLocation.__emitChange({ path: ['checkout'] });
    await runLadder();

    expect(calls).toEqual({ catalogue: 2, category: 2, member: 2 });
    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(10);
  });

  test('the change handler is registered exactly once', async () => {
    await boot();

    expect(ctx.wixLocation.__changeHandlerCount()).toBe(1);
  });

  test.each([
    ['the category', 'getVehicleCategoryDetails', 'vehicle-category-data',
      { categoryCode: 'STALE' }, (p) => p.item?.categoryCode === 'STALE'],
  ])('a %s fetch in flight across a route change does not fill the new cache', async (_label, fn, type, staleValue, isStale) => {
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

    ctx.wixLocation.__emitChange({ path: ['checkout'] });
    jest.advanceTimersByTime(RUNGS[0]);
    await flush();
    expect(pending).toBeInstanceOf(Function);

    ctx.wixLocation.__emitChange({ path: ['checkout'] });
    pending(staleValue);
    await flush();
    await runLadder();

    expect(of(type).some(isStale)).toBe(false);
  });

  test('a member lookup in flight across a route change does not fill the new cache', async () => {
    let calls = 0;
    let pending = null;
    await boot({
      async beforeStart() {
        const members = await import('wix-members-frontend');
        members.currentMember.getMember = () => {
          calls += 1;
          if (calls !== 2) return Promise.resolve(null);
          return new Promise((resolve) => { pending = resolve; });
        };
      },
    });
    await runLadder();

    ctx.wixLocation.__emitChange({ path: ['checkout'] });
    jest.advanceTimersByTime(RUNGS[0]);
    await flush();
    expect(pending).toBeInstanceOf(Function);

    ctx.wixLocation.__emitChange({ path: ['checkout'] });
    pending(MEMBER);
    await flush();
    await runLadder();

    expect(of('member-prefill').some((p) => p.member?.firstName === 'Maria')).toBe(false);
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

    ctx.wixLocation.__emitChange({ path: ['checkout'] });
    jest.advanceTimersByTime(RUNGS[0]);
    await flush();
    expect(pending).toBeInstanceOf(Function);

    ctx.wixLocation.__emitChange({ path: ['checkout'] });
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
    expect(warns).toHaveBeenCalledWith('Checkout category item unavailable', expect.any(Error));
    expect(last(BRIDGE_TYPES.PRICING).catalog).not.toBeNull();
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
    expect(warns).toHaveBeenCalledWith('Checkout pricing catalog unavailable', expect.any(Error));
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
    await boot({ beforeStart: withMember(MEMBER) });
    await runLadder();
  });

  test.each([
    [BRIDGE_TYPES.REQUEST_CONTEXT, BRIDGE_TYPES.CONTEXT],
    [BRIDGE_TYPES.REQUEST_PRICING, BRIDGE_TYPES.PRICING],
    ['request-vehicle-category-data', 'vehicle-category-data'],
    ['request-member-prefill', 'member-prefill'],
  ])('%s is answered with %s', async (request, reply) => {
    await send({ type: request });
    await flush();

    expect(of(reply)).toHaveLength(6);
  });

  test('answering one request does not send the others', async () => {
    await send({ type: 'request-member-prefill' });
    await flush();

    expect(of('member-prefill')).toHaveLength(6);
    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(5);
  });

  test('a navigation request is followed', async () => {
    await send({ type: BRIDGE_TYPES.WIX_NAV, path: '/success' });

    expect(navigatedTo()).toEqual(['/success']);
  });

  test('a pathless navigation request goes nowhere', async () => {
    await send({ type: BRIDGE_TYPES.WIX_NAV });

    expect(navigatedTo()).toEqual([]);
  });

  test('a navigation that throws is logged rather than propagated', async () => {
    ctx.wixLocation.to.mockImplementation(() => { throw new Error('blocked'); });

    await send({ type: BRIDGE_TYPES.WIX_NAV, path: '/success' });

    expect(errors).toHaveBeenCalledWith('checkout navigation failed', expect.any(Error));
  });

  test('a message from an untrusted origin reaches nothing', async () => {
    const before = html.posted.length;
    await send({ type: BRIDGE_TYPES.REQUEST_CONTEXT }, 'https://evil.example');
    await send({ type: 'submit-booking', payload: {} }, 'https://evil.example');
    await flush();

    expect(html.posted.length).toBe(before);
    expect(ctx.fake.rows('BookingsNew')).toEqual([]);
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

  test('the window carries navigation', async () => {
    await toWindow({ type: BRIDGE_TYPES.WIX_NAV, path: '/success' });

    expect(navigatedTo()).toEqual(['/success']);
  });

  test('an untrusted window origin is refused', async () => {
    await toWindow({ type: BRIDGE_TYPES.WIX_NAV, path: '/evil' }, 'https://evil.example');

    expect(navigatedTo()).toEqual([]);
  });

  test('the window navigates and nothing else — a submit there is ignored', async () => {
    const before = html.posted.length;
    await toWindow({ type: 'submit-booking', payload: { email: 'a@example.com' } });
    await toWindow({ type: BRIDGE_TYPES.REQUEST_CONTEXT });
    await toWindow(null);
    await toWindow('{ not json');

    expect(html.posted.length).toBe(before);
    expect(ctx.fake.rows('BookingsNew')).toEqual([]);
  });
});
