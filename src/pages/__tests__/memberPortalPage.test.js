import { bootPageController, createComponent } from '../../../test/helpers/bootPageController.js';

// The customer-facing member portal. The whole screen lives inside an embedded
// frame, so this controller is a thin command router: seven message types, each
// forwarded to a backend call and answered with a matching *_RESULT.
//
// The property that matters is where authority comes from. Every command
// carries its own customerId and sessionToken, straight out of a message the
// page cannot vouch for — so the router does not, and must not, treat them as
// proof of anything. What makes that safe is that the backend re-derives the
// session from the token hash on every single call. The tests below drive a
// forged customerId through each command to show the router hands it over
// unchanged and the answer comes back unauthorized.

const COMP = '#memberPortalHtml';
const TRUSTED = 'https://editor.wix.com';
const URL = 'https://diamond.example/member-portal';
const EMAIL = 'guest@example.com';
const REF = 'BK-2026-001';

const seed = () => ({
  BookingsNew: [
    {
      _id: 'b-1',
      bookingNumber: REF,
      customerId: 'cust-1',
      customerEmail: EMAIL,
      customerName: 'A Guest',
      customerPhone: '+30 210 0000000',
      status: 'Confirmed',
      pickupDateTime: '2026-04-01T10:00:00.000Z',
      dropoffDateTime: '2026-04-05T10:00:00.000Z',
      pickupLocation: 'airport-mkd',
      dropoffLocation: 'airport-mkd',
      vehicleName: 'Fiat Panda',
      totalPrice: 240,
    },
    {
      _id: 'b-2',
      bookingNumber: 'BK-2026-002',
      customerId: 'cust-2',
      customerEmail: 'someone.else@example.com',
      status: 'Confirmed',
      pickupDateTime: '2026-04-02T10:00:00.000Z',
      dropoffDateTime: '2026-04-06T10:00:00.000Z',
    },
  ],
  Customers: [
    { _id: 'cust-1', name: 'A Guest', email: EMAIL, phone: '+30 210 0000000' },
    { _id: 'cust-2', name: 'Someone Else', email: 'someone.else@example.com' },
  ],
  PortalSessions: [],
});

let ctx;
let html;
let errors;

async function boot({ bare = false, component = null } = {}) {
  html = component || createComponent(COMP);
  ctx = await bootPageController({
    importer: () => import('../MemberPortal.js'),
    components: bare ? {} : { [COMP]: html },
    seed: seed(),
    url: URL,
    path: ['member-portal'],
  });
  return ctx;
}

const send = (msg, origin = TRUSTED) => html.emitMessage({ origin, data: msg });
const last = (type) => html.postedOfType(type).pop();

/** Signs in through the page and hands back the credentials the frame would hold. */
async function signIn({ email = EMAIL, bookingRef = REF } = {}) {
  await send({ type: 'SIGN_IN', email, bookingRef });
  const auth = last('AUTH_RESULT');
  return { customerId: auth.customerId, sessionToken: auth.sessionToken, auth };
}

beforeEach(() => { errors = jest.spyOn(console, 'error').mockImplementation(() => {}); });

afterEach(async () => {
  if (ctx) await ctx.teardown();
  ctx = null;
  html = null;
  errors.mockRestore();
});

describe('the handshake', () => {
  test('PORTAL_READY is answered with the site configuration', async () => {
    await boot();

    await send({ type: 'PORTAL_READY' });

    expect(last('INIT')).toMatchObject({
      currency: 'EUR',
      companyName: 'Diamond Rent a Car',
      bookingPageUrl: '/booking',
    });
    expect(last('INIT').locations.map((l) => l.id)).toContain('airport-mkd');
  });

  test('nothing is posted before the frame speaks', async () => {
    await boot();

    expect(html.posted).toEqual([]);
  });

  test('a page with no frame binds nothing and logs nothing', async () => {
    await boot({ bare: true });

    expect(errors).not.toHaveBeenCalled();
  });

  test('the named component wins over whatever HtmlComponent comes first', async () => {
    // resolveHtmlComponent falls back to the first HtmlComponent on the page, so
    // the named candidate only earns its keep when there is more than one frame.
    const stray = createComponent('#marketingHtml');
    const portal = createComponent(COMP);
    ctx = await bootPageController({
      importer: () => import('../MemberPortal.js'),
      components: { '#marketingHtml': stray, [COMP]: portal },
      seed: seed(),
      url: URL,
      path: ['member-portal'],
    });
    html = portal;

    await send({ type: 'PORTAL_READY' });

    expect(last('INIT')).toBeTruthy();
    expect(stray.posted).toEqual([]);
  });

  test('a component that refuses the binding is logged', async () => {
    const stubborn = createComponent(COMP, { onMessage() { throw new Error('already bound'); } });
    await boot({ component: stubborn });

    expect(errors).toHaveBeenCalledWith('MemberPortal bind failed', expect.any(Error));
  });
});

describe('signing in', () => {
  beforeEach(async () => { await boot(); });

  test('a matching reference and email hands back a session', async () => {
    const { auth } = await signIn();

    expect(auth).toMatchObject({
      ok: true,
      customerId: 'cust-1',
      customer: { name: 'A Guest', email: EMAIL },
    });
    expect(auth.sessionToken).toMatch(/^[0-9a-f]{48}$/);
  });

  test('the right reference with the wrong email is refused, and told nothing more', async () => {
    // Same 'not_found' a bogus reference gets: the panel must not confirm that a
    // booking number exists to someone who cannot name its email.
    await send({ type: 'SIGN_IN', email: 'attacker@example.com', bookingRef: REF });
    const wrongEmail = last('AUTH_RESULT');

    await send({ type: 'SIGN_IN', email: EMAIL, bookingRef: 'BK-NOPE' });
    const wrongRef = last('AUTH_RESULT');

    expect(wrongEmail).toEqual({ type: 'AUTH_RESULT', ok: false, error: 'not_found' });
    expect(wrongRef).toEqual({ type: 'AUTH_RESULT', ok: false, error: 'not_found' });
  });

  test('a half-filled form is refused before any lookup', async () => {
    await send({ type: 'SIGN_IN', email: EMAIL });

    expect(last('AUTH_RESULT')).toMatchObject({ ok: false, error: 'missing_fields' });
  });

  test('a backend failure is reported as a server error, not as a refusal', async () => {
    await ctx.teardown();
    await boot({ component: (html = createComponent(COMP)) });
    const portal = await import('../../backend/memberPortal.jsw');
    const original = portal.signIn;
    portal.signIn = () => Promise.reject(new Error('database down'));
    try {
      await send({ type: 'SIGN_IN', email: EMAIL, bookingRef: REF });
    } finally {
      portal.signIn = original;
    }

    expect(last('AUTH_RESULT')).toEqual({ type: 'AUTH_RESULT', ok: false, error: 'server_error' });
  });
});

describe('the signed-in commands', () => {
  let creds;

  beforeEach(async () => {
    await boot();
    creds = await signIn();
  });

  test('GET_BOOKINGS returns only this customer’s bookings', async () => {
    await send({ type: 'GET_BOOKINGS', ...creds });

    const result = last('BOOKINGS_RESULT');
    expect(result.ok).toBe(true);
    expect(result.bookings.map((b) => b.bookingNumber)).toEqual([REF]);
  });

  test('GET_BOOKINGS passes the filter through', async () => {
    await send({ type: 'GET_BOOKINGS', ...creds, filter: 'past' });

    // The seeded rental drops off in April 2026; the clock is frozen in March.
    expect(last('BOOKINGS_RESULT').bookings).toEqual([]);
  });

  test('GET_PROFILE returns the customer record', async () => {
    await send({ type: 'GET_PROFILE', ...creds });

    expect(last('PROFILE_RESULT')).toMatchObject({
      ok: true,
      profile: { name: 'A Guest', email: EMAIL },
    });
  });

  test('UPDATE_BOOKING applies an allowed change', async () => {
    await send({
      type: 'UPDATE_BOOKING',
      ...creds,
      bookingId: 'b-1',
      changes: { notes: 'Late arrival, flight A3 991' },
    });

    expect(last('UPDATE_RESULT')).toMatchObject({
      ok: true,
      booking: { notes: 'Late arrival, flight A3 991' },
    });
  });

  test('CANCEL_BOOKING cancels and records the reason', async () => {
    await send({ type: 'CANCEL_BOOKING', ...creds, bookingId: 'b-1', reason: 'Trip called off' });

    expect(last('CANCEL_RESULT')).toMatchObject({
      ok: true,
      booking: { status: 'Canceled', cancelReason: 'Trip called off' },
    });
  });

  test('SIGN_OUT ends the session and every command after it is refused', async () => {
    await send({ type: 'SIGN_OUT', ...creds });
    expect(last('SIGN_OUT_RESULT')).toEqual({ type: 'SIGN_OUT_RESULT' });

    await send({ type: 'GET_BOOKINGS', ...creds });

    expect(last('BOOKINGS_RESULT')).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  test('SIGN_OUT still answers when the backend throws', async () => {
    const portal = await import('../../backend/memberPortal.jsw');
    const original = portal.signOut;
    portal.signOut = () => Promise.reject(new Error('database down'));
    try {
      await send({ type: 'SIGN_OUT', ...creds });
    } finally {
      portal.signOut = original;
    }

    // The frame is waiting on this to clear its own state; a swallowed error
    // that produced no reply would strand it signed in.
    expect(last('SIGN_OUT_RESULT')).toEqual({ type: 'SIGN_OUT_RESULT' });
  });
});

describe('credentials supplied by the frame', () => {
  let creds;

  beforeEach(async () => {
    await boot();
    creds = await signIn();
  });

  test.each([
    ['GET_BOOKINGS', 'BOOKINGS_RESULT', {}],
    ['GET_PROFILE', 'PROFILE_RESULT', {}],
    ['UPDATE_BOOKING', 'UPDATE_RESULT', { bookingId: 'b-2', changes: { notes: 'mine now' } }],
    ['CANCEL_BOOKING', 'CANCEL_RESULT', { bookingId: 'b-2', reason: 'mine now' }],
  ])('%s with someone else’s customerId is refused', async (type, resultType, extra) => {
    // The router forwards customerId verbatim, so this is the backend's session
    // check doing the work — which is exactly the arrangement being pinned.
    await send({ type, ...creds, customerId: 'cust-2', ...extra });

    expect(last(resultType)).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  test.each([
    ['GET_BOOKINGS', 'BOOKINGS_RESULT'],
    ['GET_PROFILE', 'PROFILE_RESULT'],
    ['UPDATE_BOOKING', 'UPDATE_RESULT'],
    ['CANCEL_BOOKING', 'CANCEL_RESULT'],
  ])('%s with an invented token is refused', async (type, resultType) => {
    await send({ type, customerId: creds.customerId, sessionToken: 'f'.repeat(48), bookingId: 'b-1' });

    expect(last(resultType)).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  test('a booking belonging to another customer is not reachable even with a valid session', async () => {
    await send({ type: 'UPDATE_BOOKING', ...creds, bookingId: 'b-2', changes: { notes: 'mine now' } });

    expect(last('UPDATE_RESULT')).toMatchObject({ ok: false, error: 'not_found' });
  });
});

describe('backend failures', () => {
  const cases = [
    ['GET_BOOKINGS', 'getCustomerBookings', 'BOOKINGS_RESULT'],
    ['GET_PROFILE', 'getCustomerProfile', 'PROFILE_RESULT'],
    ['UPDATE_BOOKING', 'updateBooking', 'UPDATE_RESULT'],
    ['CANCEL_BOOKING', 'cancelBooking', 'CANCEL_RESULT'],
  ];

  test.each(cases)('%s reports a server error when %s throws', async (type, fn, resultType) => {
    await boot();
    const creds = await signIn();
    const portal = await import('../../backend/memberPortal.jsw');
    const original = portal[fn];
    portal[fn] = () => Promise.reject(new Error('database down'));
    try {
      await send({ type, ...creds, bookingId: 'b-1', changes: { notes: 'x' } });
    } finally {
      portal[fn] = original;
    }

    expect(last(resultType)).toEqual({ type: resultType, ok: false, error: 'server_error' });
  });
});

describe('what the router refuses to act on', () => {
  beforeEach(async () => { await boot(); });

  test('a message from an untrusted origin reaches nothing', async () => {
    await send({ type: 'PORTAL_READY' }, 'https://evil.example');
    await send({ type: 'SIGN_IN', email: EMAIL, bookingRef: REF }, 'https://evil.example');

    expect(html.posted).toEqual([]);
  });

  test('an origin-less message is accepted', async () => {
    await send({ type: 'PORTAL_READY' }, '');

    expect(last('INIT')).toBeTruthy();
  });

  test('a trusted Wix suffix is accepted', async () => {
    await send({ type: 'PORTAL_READY' }, 'https://diamond.wixsite.com');

    expect(last('INIT')).toBeTruthy();
  });

  test('an unparseable payload, a null payload and a typeless object do nothing', async () => {
    await send('{ not json');
    await send(null);
    await send({ email: EMAIL });

    expect(html.posted).toEqual([]);
  });

  test('an unrecognised command does nothing', async () => {
    await send({ type: 'DELETE_EVERYTHING' });

    expect(html.posted).toEqual([]);
  });

  // Two mutation survivors here, both equivalent:
  //
  // - Narrowing the guard to `if (!data) return;` is undetectable, because a
  //   payload with no type lands on the switch's default and does nothing
  //   either way. The null half of the same guard is load-bearing and is caught.
  // - The origin check in the window listener is pure duplication: handleMessage
  //   runs the same check on the same event a moment later, so deleting the
  //   outer one changes nothing. The one inside handleMessage is the real guard,
  //   and removing *that* is caught.
});

describe('messages posted to the window', () => {
  beforeEach(async () => { await boot(); });

  // The window listener calls handleMessage without returning its promise, so
  // emitWindowMessage resolves before any backend call has finished. Anything
  // asynchronous has to be waited for separately.
  const toWindow = async (data, origin = TRUSTED) => {
    await ctx.env.emitWindowMessage({ origin, data });
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  };

  test('the window carries the same commands as the component', async () => {
    await toWindow({ type: 'PORTAL_READY' });

    expect(last('INIT')).toBeTruthy();
  });

  test('an untrusted window origin is refused', async () => {
    await toWindow({ type: 'PORTAL_READY' }, 'https://evil.example');

    expect(html.posted).toEqual([]);
  });

  test('a signed-in command works through the window too', async () => {
    const creds = await signIn();
    await toWindow({ type: 'GET_BOOKINGS', ...creds });

    expect(last('BOOKINGS_RESULT').bookings.map((b) => b.bookingNumber)).toEqual([REF]);
  });
});
