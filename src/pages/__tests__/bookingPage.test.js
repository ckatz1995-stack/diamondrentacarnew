import { bootPageController, createComponent } from '../../../test/helpers/bootPageController.js';
import { BRIDGE_TYPES } from '../../public/bridgeUtils.js';

// The booking form page. Two things set it apart from the other bridge pages.
//
// It binds *every* HtmlComponent on the page rather than one named frame, so a
// site with the form duplicated in two sections keeps both in step — and a
// stray marketing frame gets the payloads too, which the tests pin as it is.
//
// And it is the only page that reads the signed-in member's contact details and
// pushes them into the form. That prefill is best-effort by design: no member,
// or a members API that throws, means no payload at all rather than a form
// full of empty strings.

const COMP = '#bpage1';
const OTHER = '#bookingHtml';
const TRUSTED = 'https://editor.wix.com';
const URL = 'https://diamond.example/booking';

const seed = () => ({
  VehiclesNew: [
    {
      _id: 'cat-1', category: 'ECO', title: 'Fiat Panda', price: 30, active: true,
      transmission: 'Manual', fuelType: 'Petrol', seats: 5, doors: 5,
    },
    { _id: 'cat-2', category: 'SUV', title: 'Jeep Renegade', price: 70, active: true },
  ],
  FleetNew: [],
  BookingsNew: [],
  BusinessSettings: [{ _id: 'bs-1', currency: 'EUR' }],
  InsurancePlans: [],
  ExtraServices: [],
  FeeRules: [],
  PricingSeasons: [],
  CategoryRateRules: [],
  PickupLocations: [],
});

let ctx;
let html;
let warns;

/** Installs a fake signed-in member for the boot that follows. */
const withMember = (member) => async () => {
  const members = await import('wix-members-frontend');
  members.currentMember.getMember = () => Promise.resolve(member);
};

const withFailingMember = (error) => async () => {
  const members = await import('wix-members-frontend');
  members.currentMember.getMember = () => Promise.reject(error);
};

async function boot({ bare = false, query = {}, extras = {}, component = null, beforeStart = null } = {}) {
  html = component || createComponent(COMP);
  ctx = await bootPageController({
    importer: () => import('../Booking.q77ve.js'),
    components: bare ? {} : { [COMP]: html, ...extras },
    seed: seed(),
    query,
    url: URL,
    path: ['booking'],
    beforeStart,
  });
  await flush();
  return ctx;
}

const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
const runLadder = async () => { jest.advanceTimersByTime(2000); await flush(); };
const send = (msg, origin = TRUSTED) => html.emitMessage({ origin, data: msg });
const of = (type, on = html) => on.postedOfType(type);
const last = (type, on = html) => of(type, on).pop();
const navigatedTo = () => ctx.wixLocation.to.mock.calls.map((c) => c[0]);

beforeEach(() => { warns = jest.spyOn(console, 'warn').mockImplementation(() => {}); });

afterEach(async () => {
  if (ctx) await ctx.teardown();
  ctx = null;
  html = null;
  warns.mockRestore();
});

describe('opening the page', () => {
  test('nothing is posted before the first rung comes due', async () => {
    await boot();
    jest.advanceTimersByTime(99);
    await flush();

    expect(html.posted).toEqual([]);
  });

  test('the context and the category are each delivered four times', async () => {
    await boot({ query: { category: 'ECO' } });
    await runLadder();

    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(4);
    expect(of('vehicle-category-data')).toHaveLength(4);
  });

  test('every HtmlComponent on the page is fed, not just the first', async () => {
    const second = createComponent(OTHER);
    await boot({ query: { category: 'ECO' }, extras: { [OTHER]: second } });
    await runLadder();

    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(4);
    expect(of(BRIDGE_TYPES.CONTEXT, second)).toHaveLength(4);
    expect(last('vehicle-category-data', second).item).toMatchObject({ categoryCode: 'ECO' });
  });

  test('a message from either frame is answered on that same frame', async () => {
    const second = createComponent(OTHER);
    await boot({ query: { category: 'ECO' }, extras: { [OTHER]: second } });
    await runLadder();
    const before = of(BRIDGE_TYPES.CONTEXT).length;

    await second.emitMessage({ origin: TRUSTED, data: { type: BRIDGE_TYPES.REQUEST_CONTEXT } });

    expect(of(BRIDGE_TYPES.CONTEXT, second)).toHaveLength(before + 1);
    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(before);
  });

  test('a page with no frames at all does nothing, and listens for nothing', async () => {
    await boot({ bare: true });
    await runLadder();

    expect(ctx.env.windowListenerCount()).toBe(0);
  });

  test('a page whose component list cannot be read is treated as having none', async () => {
    // $w('HtmlComponent') is a live query against the rendered page; a component
    // still initialising can make it throw. The page then has nothing to talk
    // to, which is the same situation as having no frames.
    const hostile = createComponent(COMP);
    Object.defineProperty(hostile, 'type', {
      get() { throw new Error('component not ready'); },
    });
    await boot({ component: hostile });
    await runLadder();

    expect(hostile.posted).toEqual([]);
    expect(ctx.env.windowListenerCount()).toBe(0);
  });

  test('a frame that refuses the binding is logged, and the others still bind', async () => {
    const stubborn = createComponent(COMP, { onMessage() { throw new Error('already bound'); } });
    const second = createComponent(OTHER);
    await boot({ query: { category: 'ECO' }, component: stubborn, extras: { [OTHER]: second } });
    await runLadder();

    expect(warns).toHaveBeenCalledWith('Failed to bind HTML component message', expect.any(Error));
    await second.emitMessage({ origin: TRUSTED, data: { type: BRIDGE_TYPES.REQUEST_CONTEXT } });
    expect(of(BRIDGE_TYPES.CONTEXT, second)).toHaveLength(5);
  });

  test('the context carries the page URL, path and query', async () => {
    await boot({ query: { category: 'ECO' } });
    await runLadder();

    expect(of(BRIDGE_TYPES.CONTEXT)[0]).toMatchObject({
      url: URL, path: ['booking'], query: { category: 'ECO' },
    });
  });
});

describe('which vehicle the page is about', () => {
  test.each([
    ['vehicle', { vehicle: 'cat-2' }, 'SUV'],
    ['vehicleId', { vehicleId: 'cat-2' }, 'SUV'],
    ['category', { category: 'ECO' }, 'ECO'],
  ])('the %s query parameter selects it', async (_name, query, code) => {
    await boot({ query });
    await runLadder();

    expect(last('vehicle-category-data').item).toMatchObject({ categoryCode: code });
  });

  // Mutation note: the page's own trim on the vehicle id is unobservable —
  // findVehicleCategoryRecord trims again before querying. Kept below for the
  // behaviour rather than for the page's line.
  test('a padded vehicle id is trimmed before the lookup', async () => {
    await boot({ query: { vehicle: '  cat-2  ' } });
    await runLadder();

    expect(last('vehicle-category-data').item).toMatchObject({ categoryCode: 'SUV' });
  });

  test('a URL naming no vehicle delivers a null item rather than nothing', async () => {
    await boot({ query: {} });
    await runLadder();

    // The frame needs an answer either way; silence would leave it waiting.
    expect(of('vehicle-category-data')).toHaveLength(4);
    expect(last('vehicle-category-data').item).toBeNull();
  });

  test('the category is fetched once and served from the cache after that', async () => {
    let calls = 0;
    await boot({
      query: { category: 'ECO' },
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        const real = engine.getVehicleCategoryDetails;
        engine.getVehicleCategoryDetails = (...args) => { calls += 1; return real(...args); };
      },
    });
    expect(calls).toBe(1);

    await runLadder();
    const before = of('vehicle-category-data').length;
    await send({ type: 'request-vehicle-category-data' });
    await flush();

    expect(calls).toBe(1);
    // Answered from the cache, but answered: a request the page silently
    // dropped would look identical if only the call count were checked.
    expect(of('vehicle-category-data')).toHaveLength(before + 1);
  });

  test('two requests in the same tick share one lookup', async () => {
    let calls = 0;
    let pending = null;
    await boot({
      query: { category: 'ECO' },
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.getVehicleCategoryDetails = () => {
          calls += 1;
          // The ready lookup answers null, which the cache does not keep, so
          // the next request goes back out — and that one is left hanging long
          // enough for a second to arrive alongside it.
          if (calls === 1) return Promise.resolve(null);
          return new Promise((resolve) => { pending = resolve; });
        };
      },
    });

    // Not awaited: each send stays suspended on the hanging lookup, which is
    // the whole point — the second has to arrive while the first is in flight.
    const inFlight = [
      send({ type: 'request-vehicle-category-data' }),
      send({ type: 'request-vehicle-category-data' }),
    ];
    expect(pending).toBeInstanceOf(Function);
    pending({ categoryCode: 'ECO' });
    await Promise.all(inFlight);
    await flush();

    expect(calls).toBe(2);
    expect(of('vehicle-category-data')).toHaveLength(2);
    expect(of('vehicle-category-data').every((p) => p.item?.categoryCode === 'ECO')).toBe(true);
  });

  // Mutation note: `item || null` never sees undefined — ensureCategoryItem
  // normalises to null on the cached, resolved and failed paths alike.

  test('a failing lookup is reported as a null item and logged', async () => {
    await boot({
      query: { category: 'ECO' },
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.getVehicleCategoryDetails = () => Promise.reject(new Error('fleet offline'));
      },
    });
    await runLadder();

    expect(last('vehicle-category-data').item).toBeNull();
    expect(warns).toHaveBeenCalledWith('Booking category item unavailable', expect.any(Error));
  });
});

describe('the member prefill', () => {
  const member = {
    loginEmail: 'login@example.com',
    contactDetails: {
      firstName: 'Maria', lastName: 'Pappas',
      emails: ['maria@example.com'], phones: ['+30 210 1111111'],
      addresses: [
        // No street, no city, no postcode — skipped in favour of the real one.
        { country: 'GR' },
        { addressLine: '12 Tsimiski', addressLine2: 'Floor 3', city: 'Thessaloniki', country: 'GR', postalCode: '54624' },
      ],
    },
  };

  test('a signed-in member’s details reach the form', async () => {
    await boot({ query: { category: 'ECO' }, beforeStart: withMember(member) });
    await runLadder();

    expect(last('member-prefill').member).toEqual({
      firstName: 'Maria', lastName: 'Pappas',
      email: 'maria@example.com', phone: '+30 210 1111111',
      address: '12 Tsimiski', address2: 'Floor 3',
      city: 'Thessaloniki', country: 'GR', postalCode: '54624',
    });
  });

  test('the same payload is sent twice under two keys, for two generations of frame', async () => {
    await boot({ query: { category: 'ECO' }, beforeStart: withMember(member) });
    await runLadder();

    const payload = last('member-prefill');
    expect(payload.payload).toEqual(payload.member);
  });

  test('the login email stands in when the contact record has none', async () => {
    await boot({
      query: { category: 'ECO' },
      beforeStart: withMember({ loginEmail: 'login@example.com', contactDetails: { firstName: 'Maria' } }),
    });
    await runLadder();

    expect(last('member-prefill').member).toMatchObject({ email: 'login@example.com', address: '' });
  });

  test('the first address is used when none of them look complete', async () => {
    await boot({
      query: { category: 'ECO' },
      beforeStart: withMember({ contactDetails: { addresses: [{ country: 'GR' }, { country: 'CY' }] } }),
    });
    await runLadder();

    expect(last('member-prefill').member).toMatchObject({ country: 'GR', address: '' });
  });

  test('an addresses field that is not a list is ignored rather than indexed', async () => {
    await boot({
      query: { category: 'ECO' },
      beforeStart: withMember({ contactDetails: { firstName: 'Maria', addresses: 'not a list' } }),
    });
    await runLadder();

    expect(last('member-prefill').member).toMatchObject({ firstName: 'Maria', city: '', postalCode: '' });
  });

  test('a signed-out visitor gets no prefill payload at all, and no error either', async () => {
    await boot({ query: { category: 'ECO' } });
    await runLadder();

    // An empty form is the right outcome; a payload of empty strings would
    // overwrite anything the visitor had already typed. The absence of a warning
    // matters too: without the explicit null check this path reaches the form
    // by throwing, and every signed-out visit would log an error.
    expect(of('member-prefill')).toEqual([]);
    expect(warns).not.toHaveBeenCalledWith('Member prefill unavailable', expect.anything());
  });

  test('the full contact fieldset is requested, not the default one', async () => {
    // The default fieldset omits addresses and phones, so the form would come
    // back with a name and nothing else.
    const seen = [];
    await boot({
      query: { category: 'ECO' },
      async beforeStart() {
        const members = await import('wix-members-frontend');
        members.currentMember.getMember = (options) => { seen.push(options); return Promise.resolve(member); };
      },
    });
    await runLadder();

    expect(seen[0]).toEqual({ fieldsets: ['FULL'] });
  });

  test('an address with a city but no street still counts as the filled-in one', async () => {
    await boot({
      query: { category: 'ECO' },
      beforeStart: withMember({
        contactDetails: {
          addresses: [{ country: 'GR' }, { city: 'Thessaloniki', country: 'GR' }],
        },
      }),
    });
    await runLadder();

    expect(last('member-prefill').member).toMatchObject({ city: 'Thessaloniki', address: '' });
  });

  test('a members API that throws is logged and produces no payload', async () => {
    await boot({ query: { category: 'ECO' }, beforeStart: withFailingMember(new Error('members offline')) });
    await runLadder();

    expect(of('member-prefill')).toEqual([]);
    expect(warns).toHaveBeenCalledWith('Member prefill unavailable', expect.any(Error));
  });

  test('the prefill is re-read on request rather than cached', async () => {
    let calls = 0;
    await boot({
      query: { category: 'ECO' },
      async beforeStart() {
        const members = await import('wix-members-frontend');
        members.currentMember.getMember = () => { calls += 1; return Promise.resolve(member); };
      },
    });
    await runLadder();
    const before = calls;

    await send({ type: 'request-member-prefill' });
    await flush();

    expect(calls).toBe(before + 1);
    expect(of('member-prefill')).toHaveLength(before + 1);
  });
});

describe('submitting a booking', () => {
  test('a form missing required fields is refused by the backend and the reason relayed', async () => {
    await boot({ query: { category: 'ECO' } });

    await send({ type: 'submit-booking', payload: { email: 'guest@example.com' } });
    await flush();

    expect(last('booking-submit-result')).toMatchObject({
      success: false,
      message: 'Λείπουν υποχρεωτικά πεδία.',
    });
  });

  test('a successful booking is relayed with its number and id', async () => {
    await boot({
      query: { category: 'ECO' },
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
      success: true,
      bookingNumber: 'BK-2026-007',
      id: 'b-7',
      message: 'ok',
    });
  });

  test('an id under the other spelling is still relayed', async () => {
    await boot({
      query: { category: 'ECO' },
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
      query: { category: 'ECO' },
      async beforeStart() {
        const engine = await import('../../backend/bookingEngine.jsw');
        engine.createBooking = () => Promise.reject(new Error('database down'));
      },
    });

    await send({ type: 'submit-booking', payload: {} });
    await flush();

    expect(last('booking-submit-result')).toEqual({
      type: 'booking-submit-result',
      success: false,
      message: 'database down',
    });
  });

  test('a thrown value with no message is still reported', async () => {
    await boot({
      query: { category: 'ECO' },
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
      query: { category: 'ECO' },
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

describe('what the frame refuses to act on', () => {
  beforeEach(async () => {
    await boot({ query: { category: 'ECO' } });
    await runLadder();
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

    expect(of(BRIDGE_TYPES.CONTEXT)).toHaveLength(5);
  });

  test('an unparseable payload, a null payload and an unknown type do nothing', async () => {
    const before = html.posted.length;
    await send('{ not json');
    await send(null);
    await send({ type: 'something-else' });
    await flush();

    expect(html.posted.length).toBe(before);
  });

  test('a navigation request is followed', async () => {
    await send({ type: BRIDGE_TYPES.WIX_NAV, path: '/checkout' });

    expect(navigatedTo()).toEqual(['/checkout']);
  });

  test('a pathless navigation request goes nowhere', async () => {
    await send({ type: BRIDGE_TYPES.WIX_NAV });
    await send({ type: BRIDGE_TYPES.WIX_NAV, path: '' });

    expect(navigatedTo()).toEqual([]);
  });

  test('a navigation that throws is logged rather than propagated', async () => {
    ctx.wixLocation.to.mockImplementation(() => { throw new Error('blocked'); });

    await send({ type: BRIDGE_TYPES.WIX_NAV, path: '/checkout' });

    expect(warns).toHaveBeenCalledWith('Booking navigation failed', expect.any(Error));
  });
});

describe('messages posted to the window', () => {
  beforeEach(async () => {
    await boot({ query: { category: 'ECO' } });
    await runLadder();
  });

  const toWindow = async (data, origin = TRUSTED) => {
    await ctx.env.emitWindowMessage({ origin, data });
    await flush();
  };

  test('the window carries navigation', async () => {
    await toWindow({ type: BRIDGE_TYPES.WIX_NAV, path: '/checkout' });

    expect(navigatedTo()).toEqual(['/checkout']);
  });

  test('an untrusted window origin is refused', async () => {
    await toWindow({ type: BRIDGE_TYPES.WIX_NAV, path: '/evil' }, 'https://evil.example');

    expect(navigatedTo()).toEqual([]);
  });

  test('the window navigates and nothing else — requests there are ignored', async () => {
    const before = html.posted.length;
    await toWindow({ type: BRIDGE_TYPES.REQUEST_CONTEXT });
    await toWindow({ type: 'request-member-prefill' });
    await toWindow(null);
    await toWindow('{ not json');

    expect(html.posted.length).toBe(before);
  });

  test('a window navigation that throws is logged', async () => {
    ctx.wixLocation.to.mockImplementation(() => { throw new Error('blocked'); });

    await toWindow({ type: BRIDGE_TYPES.WIX_NAV, path: '/checkout' });

    expect(warns).toHaveBeenCalledWith('Booking navigation failed', expect.any(Error));
  });
});
