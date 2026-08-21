import { bootPageController, createComponent, staffSeed } from '../../../test/helpers/bootPageController.js';
import { derivePasswordHash, randomHex } from '../../backend/staffAccess.jsw';
import { APP_ROUTES } from '../../public/appRoutes.js';

// The daily operations board: today's check-outs, check-ins, new bookings and
// pending requests, with deep links out to every other backroom screen.
//
// Two things distinguish it. Its origin check is written in the strict form
// (`if (!isTrustedBridgeOrigin(...))`) rather than the `origin &&` form the
// other backroom pages use — same net effect today, since an empty origin is
// trusted, but it is the spelling that would hold if that changed. And the page
// is gated at rentals/View while the triage action it exposes demands
// bookings/Edit, so the page gate is deliberately the weaker of the two.

const COMP = '#dailyHtml';
const ALT = '#bpage1';
const ADMIN = 'admin@example.com';
const VIEWER = 'viewer@example.com';
const OUTSIDER = 'pricing@example.com';
const PASSWORD = 'correct-horse-battery';
const TRUSTED = 'https://editor.wix.com';
const URL = 'https://diamond.example/site/myroom-daily';
const DATE = '2026-03-10';

function seed() {
  const salt = randomHex(16);
  const cred = (email) => ({
    _id: `cred-${email}`, email, passwordSalt: salt,
    passwordHash: derivePasswordHash(PASSWORD, salt), active: true,
  });
  const base = staffSeed(derivePasswordHash, randomHex, {
    email: ADMIN,
    password: PASSWORD,
    // Reads the board, cannot act on a request: rentalsView without bookingsEdit.
    roles: [
      { _id: 'role-viewer', key: 'rentalsviewer', label: 'Rentals viewer', active: true, rentalsView: true, specialPermissions: '' },
      // Signed in with no rentals permission at all — the only account that can
      // tell the guard's `area: 'rentals'` from a bare signed-in check.
      { _id: 'role-pricing', key: 'pricingonly', label: 'Pricing only', active: true, pricingView: true, specialPermissions: '' },
    ],
    users: [
      { _id: 'u-2', email: VIEWER, fullName: 'A Viewer', roleKey: 'rentalsviewer', active: true },
      { _id: 'u-3', email: OUTSIDER, fullName: 'An Outsider', roleKey: 'pricingonly', active: true },
    ],
    extraCreds: [cred(VIEWER), cred(OUTSIDER)],
  });
  return {
    ...base,
    BookingsNew: [
      {
        _id: 'b-1', bookingNumber: 'BK-1', status: 'Confirmed', rentalState: 'Booking',
        customerName: 'A Guest', assignedVehicle: 'f-1',
        pickupDateTime: `${DATE}T09:00:00.000Z`, dropoffDateTime: `${DATE}T18:00:00.000Z`,
        confirmedAt: `${DATE}T08:00:00.000Z`,
      },
      {
        _id: 'b-2', bookingNumber: 'BK-2', status: 'Pending', rentalState: 'Booking',
        customerName: 'B Guest',
        pickupDateTime: `${DATE}T14:00:00.000Z`, dropoffDateTime: '2026-03-12T14:00:00.000Z',
      },
    ],
    FleetNew: [
      { _id: 'f-1', fleetVehicleId: 'DRC-001', plate: 'AAA-1', model: 'Fiat Panda', active: true },
    ],
    RentalsNew: [],
  };
}

let ctx;
let html;
let warns;

async function boot({
  signInAs = ADMIN,
  query = { date: DATE },
  bare = false,
  component = null,
  extras = {},
  url = URL,
} = {}) {
  html = component || createComponent(COMP);
  ctx = await bootPageController({
    importer: () => import('../Daily View.yjgoi.js'),
    components: bare ? {} : { [COMP]: html, ...extras },
    seed: seed(),
    signInAs,
    password: PASSWORD,
    query,
    url,
    path: ['site', 'myroom-daily'],
  });
  await flush();
  return ctx;
}

const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
const send = (msg, origin = TRUSTED) => html.emitMessage({ origin, data: msg });
const of = (type) => html.postedOfType(type);
const last = (type) => of(type).pop();
const navigatedTo = () => ctx.wixLocation.to.mock.calls.map((c) => c[0]);
/** Lets the 160ms focus deferral fire while $w is still installed. */
const settleFocus = async () => { jest.advanceTimersByTime(200); await flush(); };

beforeEach(() => { warns = jest.spyOn(console, 'warn').mockImplementation(() => {}); });

afterEach(async () => {
  if (ctx) await ctx.teardown();
  ctx = null;
  html = null;
  warns.mockRestore();
});

describe('the access guard', () => {
  test('an operator with rentals access gets the board', async () => {
    await boot();

    expect(html.expanded).toBe(1);
    expect(html.shown).toBe(1);
    expect(navigatedTo()).toEqual([]);
    expect(of('resume')).toHaveLength(1);
    expect(last('loadDailyOps')).toBeTruthy();
  });

  test('a signed-out visitor is bounced to the backroom home carrying where they were', async () => {
    await boot({ signInAs: null });

    expect(navigatedTo()).toEqual([`${APP_ROUTES.home}?next=${encodeURIComponent('/site/myroom-daily')}`]);
    expect(html.posted).toEqual([]);
  });

  test('a signed-in operator with no rentals permission is bounced, and marked as denied', async () => {
    await boot({ signInAs: OUTSIDER });

    expect(navigatedTo()).toEqual([
      `${APP_ROUTES.home}?next=${encodeURIComponent('/site/myroom-daily')}&denied=1`,
    ]);
    expect(html.posted).toEqual([]);
  });

  test('a view-only operator is let in — the page gate is View, not Edit', async () => {
    await boot({ signInAs: VIEWER });

    expect(navigatedTo()).toEqual([]);
    expect(last('loadDailyOps')).toBeTruthy();
  });

  test('a page with no frame does nothing beyond the guard', async () => {
    await boot({ bare: true });

    expect(navigatedTo()).toEqual([]);
  });

  test('the opening height is set, and a frame that refuses it is logged', async () => {
    await boot();
    expect(html.height).toBe(1400);

    await ctx.teardown();
    const stubborn = createComponent(COMP);
    Object.defineProperty(stubborn, 'height', {
      get() { return undefined; },
      set() { throw new Error('read only'); },
    });
    await boot({ component: stubborn });

    expect(warns).toHaveBeenCalledWith('[Daily View] initial height set failed', 'read only');
  });

  test('a frame that refuses to expand is still wired up', async () => {
    const stubborn = createComponent(COMP, { expand() { throw new Error('locked'); } });
    await boot({ component: stubborn });

    expect(warns).toHaveBeenCalledWith('[Daily View] expand/show failed', 'locked');
    expect(last('loadDailyOps')).toBeTruthy();
  });

  test('sibling frames are collapsed and both board ids are spared', async () => {
    const alt = createComponent(ALT);
    const stray = createComponent('#legacyHtml');
    await boot({ extras: { [ALT]: alt, '#legacyHtml': stray } });

    expect(stray.collapsed).toBe(1);
    expect(stray.hidden).toBe(1);
    expect(alt.collapsed).toBe(0);
    expect(html.collapsed).toBe(0);
  });
});

describe('loading the board', () => {
  test('the day’s check-outs, check-ins and new bookings arrive', async () => {
    await boot();

    const payload = last('loadDailyOps');
    expect(payload.checkOut.map((b) => b.bookingNumber)).toEqual(['BK-1']);
    expect(payload.checkIn.map((b) => b.bookingNumber)).toEqual(['BK-1']);
    expect(payload.bookings.map((b) => b.bookingNumber)).toEqual(['BK-1']);
    expect(payload.stations).toEqual(expect.any(Array));
  });

  test('the tab buckets come through when the backend fills them', async () => {
    await boot();

    const payload = last('loadDailyOps');
    expect(payload.tabs.checkout.map((b) => b.bookingNumber)).toEqual(['BK-1']);
    expect(payload.tabs.checkin.map((b) => b.bookingNumber)).toEqual(['BK-1']);
    expect(payload.tabs.bookings.map((b) => b.bookingNumber)).toEqual(['BK-1']);
  });

  test('an older backend that sends only the flat lists has its tabs backfilled', async () => {
    // The live backend fills `tabs` itself, so this compatibility path is only
    // reachable from a response shaped the way the endpoint used to answer.
    await boot();
    const ops = await import('../../backend/dailyOps.jsw');
    const original = ops.getDailyOps;
    ops.getDailyOps = () => Promise.resolve({
      checkOut: [{ bookingNumber: 'OUT-1' }],
      checkIn: [{ bookingNumber: 'IN-1' }],
      bookings: [{ bookingNumber: 'NEW-1' }],
      tabs: {},
    });
    try {
      await send({ type: 'requestDailyReload' });
      await flush();
    } finally {
      ops.getDailyOps = original;
    }

    const payload = last('loadDailyOps');
    expect(payload.tabs.checkout.map((b) => b.bookingNumber)).toEqual(['OUT-1']);
    expect(payload.tabs.checkin.map((b) => b.bookingNumber)).toEqual(['IN-1']);
    expect(payload.tabs.bookings.map((b) => b.bookingNumber)).toEqual(['NEW-1']);
  });

  test('tabs the backend did fill are left alone rather than overwritten', async () => {
    await boot();
    const ops = await import('../../backend/dailyOps.jsw');
    const original = ops.getDailyOps;
    ops.getDailyOps = () => Promise.resolve({
      checkOut: [{ bookingNumber: 'OUT-1' }],
      tabs: { checkout: [{ bookingNumber: 'CURATED' }] },
    });
    try {
      await send({ type: 'requestDailyReload' });
      await flush();
    } finally {
      ops.getDailyOps = original;
    }

    expect(last('loadDailyOps').tabs.checkout.map((b) => b.bookingNumber)).toEqual(['CURATED']);
  });

  test('a date in the query decides which day is loaded', async () => {
    await boot({ query: { date: '2026-04-20' } });

    // Nothing is booked that day, so every bucket is empty — which is the proof
    // the date was honoured rather than ignored.
    const payload = last('loadDailyOps');
    expect(payload.checkOut).toEqual([]);
    expect(payload.checkIn).toEqual([]);
  });

  test.each([
    ['a malformed date', '20-03-2026'],
    ['a date with words in it', 'yesterday'],
    ['an empty date', ''],
  ])('%s falls back to today', async (_label, date) => {
    // Observed through the deep links, which carry whichever date the page
    // settled on.
    await boot({ query: { date } });

    await send({ type: 'openContract', bookingId: 'b-1' });

    const target = navigatedTo()[0];
    expect(target).toMatch(/&date=\d{4}-\d{2}-\d{2}$/);
    expect(target).not.toContain(`date=${date}&`);
    expect(target.endsWith(`date=${date}`)).toBe(false);
  });

  test('a date that is impossible but well-shaped is passed straight through', async () => {
    // normalizeDateParam tests the shape and nothing else, so 2026-13-45 is
    // accepted. makeRange then hands it to `new Date(2026, 12, 45)`, which rolls
    // over into February 2027 — the board quietly shows a different day rather
    // than refusing the URL. Pinned as it behaves; the fix would be a calendar
    // check, which is a change to make deliberately rather than in passing.
    const seen = [];
    await boot({ query: { date: '2026-13-45' } });
    const ops = await import('../../backend/dailyOps.jsw');
    const original = ops.getDailyOps;
    ops.getDailyOps = (args) => { seen.push(args); return original(args); };
    try {
      await send({ type: 'requestDailyReload' });
      await flush();
    } finally {
      ops.getDailyOps = original;
    }

    await send({ type: 'openContract', bookingId: 'b-1' });
    expect(navigatedTo()[0]).toContain('date=2026-13-45');
    expect(seen[0].startISO.slice(0, 7)).toBe('2027-02');
  });

  test('a backend that reports failure produces an empty board carrying the reason', async () => {
    await boot({ query: { date: DATE, bookingId: 'b-1' } });
    const before = of('loadDailyOps').length;
    const ops = await import('../../backend/dailyOps.jsw');
    const original = ops.getDailyOps;
    ops.getDailyOps = () => Promise.resolve({ success: false, message: 'Invalid range' });
    try {
      await send({ type: 'requestDailyReload' });
      await flush();
    } finally {
      ops.getDailyOps = original;
    }

    const payload = last('loadDailyOps');
    expect(of('loadDailyOps')).toHaveLength(before + 1);
    expect(payload).toMatchObject({
      checkOut: [], checkIn: [], bookings: [], tabs: {}, summary: {}, stations: [],
      debug: { message: 'Invalid range' },
    });
  });

  test('a backend that throws produces an empty board carrying the error and the range', async () => {
    await boot();
    const ops = await import('../../backend/dailyOps.jsw');
    const original = ops.getDailyOps;
    ops.getDailyOps = () => Promise.reject(new Error('database down'));
    try {
      await send({ type: 'requestDailyReload' });
      await flush();
    } finally {
      ops.getDailyOps = original;
    }

    expect(last('loadDailyOps').debug).toMatchObject({
      error: 'database down',
      startISO: expect.any(String),
      endISO: expect.any(String),
    });
  });

  test('an explicit range from the frame overrides the day’s own bounds', async () => {
    const seen = [];
    await boot();
    const ops = await import('../../backend/dailyOps.jsw');
    const original = ops.getDailyOps;
    ops.getDailyOps = (args) => { seen.push(args); return original(args); };
    try {
      await send({
        type: 'requestDailyData',
        // Deliberately a slice of the day rather than the whole of it: the
        // day's own bounds are midnight to midnight, so a range equal to those
        // could not tell "honoured" from "ignored".
        startISO: '2026-03-10T06:00:00.000Z',
        endISO: '2026-03-10T12:00:00.000Z',
      });
      await flush();
    } finally {
      ops.getDailyOps = original;
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      startISO: '2026-03-10T06:00:00.000Z',
      endISO: '2026-03-10T12:00:00.000Z',
    });
  });

  test('an unparseable range from the frame is ignored in favour of the day’s bounds', async () => {
    const seen = [];
    await boot();
    const ops = await import('../../backend/dailyOps.jsw');
    const original = ops.getDailyOps;
    ops.getDailyOps = (args) => { seen.push(args); return original(args); };
    try {
      await send({ type: 'requestDailyData', startISO: 'not a date', endISO: '' });
      await flush();
    } finally {
      ops.getDailyOps = original;
    }

    expect(seen[0].startISO).not.toBe('not a date');
    expect(seen[0].startISO).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test.each(['dailyReady', 'requestDailyReload', 'requestDailyData'])('%s reloads the board', async (type) => {
    await boot();
    const before = of('loadDailyOps').length;

    await send({ type });
    await flush();

    expect(of('loadDailyOps')).toHaveLength(before + 1);
  });

  test('a date supplied with the reload message changes the day', async () => {
    await boot();

    await send({ type: 'requestDailyReload', date: '2026-04-20' });
    await flush();
    await send({ type: 'openContract', bookingId: 'b-1' });

    expect(navigatedTo()[0]).toContain('date=2026-04-20');
  });
});

describe('the deferred focus', () => {
  test('a bookingId in the query is echoed back once the board has loaded', async () => {
    await boot({ query: { date: DATE, bookingId: 'b-1', tab: 'checkin', view: 'list' } });

    expect(of('focusBooking')).toEqual([]);
    // Still nothing a millisecond before the deferral is due: the frame needs
    // the interval to bind its own handlers before the focus lands.
    jest.advanceTimersByTime(159);
    await flush();
    expect(of('focusBooking')).toEqual([]);

    await settleFocus();

    expect(last('focusBooking')).toEqual({
      type: 'focusBooking', bookingId: 'b-1', preferredTab: 'checkin', viewMode: 'list',
    });
  });

  test('the focus is sent once and not repeated on every later reload', async () => {
    await boot({ query: { date: DATE, bookingId: 'b-1' } });
    await settleFocus();
    expect(of('focusBooking')).toHaveLength(1);

    await send({ type: 'requestDailyReload' });
    await flush();
    await settleFocus();

    expect(of('focusBooking')).toHaveLength(1);
  });

  test('no bookingId means no focus message at all', async () => {
    await boot();
    await settleFocus();

    expect(of('focusBooking')).toEqual([]);
  });

  test('a whitespace-only bookingId is not a focus request', async () => {
    await boot({ query: { date: DATE, bookingId: '   ' } });
    await settleFocus();

    expect(of('focusBooking')).toEqual([]);
  });
});

describe('the deep links out', () => {
  beforeEach(async () => { await boot(); });

  test('openOnFleet carries the booking, the day and an explicit range', async () => {
    await send({
      type: 'openOnFleet', bookingId: 'b-1',
      startDate: '2026-03-11', endDate: '2026-03-14',
    });

    expect(navigatedTo()).toEqual([
      `${APP_ROUTES.fleet}?bookingId=b-1&from=daily&startDate=2026-03-11&endDate=2026-03-14&date=${DATE}`,
    ]);
  });

  test('openOnFleet with no dates falls back to the day being viewed', async () => {
    await send({ type: 'openOnFleet', bookingId: 'b-1' });

    expect(navigatedTo()[0]).toContain(`startDate=${DATE}&endDate=${DATE}`);
  });

  test('openOnFleet takes the end date from the start when only one is given', async () => {
    await send({ type: 'openOnFleet', bookingId: 'b-1', startDate: '2026-03-11' });

    expect(navigatedTo()[0]).toContain('startDate=2026-03-11&endDate=2026-03-11');
  });

  test('openOnFleet accepts the singular date field too', async () => {
    await send({ type: 'openOnFleet', bookingId: 'b-1', date: '2026-03-12' });

    expect(navigatedTo()[0]).toContain('startDate=2026-03-12&endDate=2026-03-12');
  });

  test('openOnFleet without a booking still opens the chart on the day', async () => {
    await send({ type: 'openOnFleet' });

    expect(navigatedTo()[0]).not.toContain('bookingId=');
    expect(navigatedTo()[0]).toContain('from=daily');
  });

  test('openOnBookings carries the day, the booking and the range', async () => {
    await send({ type: 'openOnBookings', bookingId: 'b-1', startDate: '2026-03-11' });

    expect(navigatedTo()).toEqual([
      `${APP_ROUTES.bookings}?from=daily&date=${DATE}&bookingId=b-1&startDate=2026-03-11&endDate=2026-03-11`,
    ]);
  });

  test('openOnBookings without a booking still opens the board', async () => {
    await send({ type: 'openOnBookings' });

    expect(navigatedTo()[0]).not.toContain('bookingId=');
  });

  test('openContract carries the booking, the origin and the day', async () => {
    await send({ type: 'openContract', bookingId: 'b-1' });

    expect(navigatedTo()).toEqual([`${APP_ROUTES.contract}?bookingId=b-1&from=daily&date=${DATE}`]);
  });

  test('openContract with no booking goes nowhere', async () => {
    await send({ type: 'openContract' });
    await send({ type: 'openContract', bookingId: '' });

    expect(navigatedTo()).toEqual([]);
  });

  test('openVehicleCard carries the vehicle, the origin and the day', async () => {
    await send({ type: 'openVehicleCard', fleetVehicleId: 'DRC-001' });

    expect(navigatedTo()).toEqual([
      `${APP_ROUTES.vehiclecard}?fleetVehicleId=DRC-001&from=daily&date=${DATE}`,
    ]);
  });

  test('openVehicleCard accepts the vehicleId spelling and carries a booking when given one', async () => {
    await send({ type: 'openVehicleCard', vehicleId: 'DRC-001', bookingId: 'b-1' });

    expect(navigatedTo()[0]).toContain('fleetVehicleId=DRC-001');
    expect(navigatedTo()[0]).toContain('bookingId=b-1');
  });

  test('openVehicleCard with no vehicle goes nowhere', async () => {
    await send({ type: 'openVehicleCard' });
    await send({ type: 'openVehicleCard', fleetVehicleId: '   ' });

    expect(navigatedTo()).toEqual([]);
  });

  test('a booking id needing escaping is encoded', async () => {
    await send({ type: 'openContract', bookingId: 'B 1&x=2' });

    expect(navigatedTo()).toEqual([
      `${APP_ROUTES.contract}?bookingId=B+1%26x%3D2&from=daily&date=${DATE}`,
    ]);
  });
});

describe('acting on a request', () => {
  test('an accepted request is confirmed and the board reloaded', async () => {
    await boot();
    const before = of('loadDailyOps').length;

    await send({ type: 'dailyRequestAction', bookingId: 'b-2', action: 'accept', actorName: 'A Operator' });
    await flush();

    expect(last('dailyActionResult')).toMatchObject({ success: true });
    expect(ctx.fake.rows('BookingsNew').find((b) => b._id === 'b-2').status).toBe('Confirmed');
    // The board is refreshed so the request leaves the pending tab.
    expect(of('loadDailyOps')).toHaveLength(before + 1);
  });

  test('a view-only operator is refused, and the booking is untouched', async () => {
    await boot({ signInAs: VIEWER });

    await send({ type: 'dailyRequestAction', bookingId: 'b-2', action: 'accept' });
    await flush();

    expect(last('dailyActionResult')).toMatchObject({ success: false });
    expect(ctx.fake.rows('BookingsNew').find((b) => b._id === 'b-2').status).toBe('Pending');
  });

  test('an unknown action is refused by the backend and the reason relayed', async () => {
    await boot();

    await send({ type: 'dailyRequestAction', bookingId: 'b-2', action: 'detonate' });
    await flush();

    expect(last('dailyActionResult')).toEqual({
      type: 'dailyActionResult', success: false, message: 'Unknown action',
    });
  });

  test('a reassignment with no target owner is refused', async () => {
    await boot();

    await send({ type: 'dailyRequestAction', bookingId: 'b-2', action: 'reassign' });
    await flush();

    expect(last('dailyActionResult')).toMatchObject({ success: false, message: 'Missing target owner' });
  });

  test('a reassignment with a target owner is accepted', async () => {
    await boot();

    await send({ type: 'dailyRequestAction', bookingId: 'b-2', action: 'reassign', targetOwner: 'B Operator' });
    await flush();

    expect(last('dailyActionResult')).toMatchObject({ success: true, message: expect.stringContaining('B Operator') });
  });

  test('an action with no booking or no verb never reaches the backend', async () => {
    await boot();

    await send({ type: 'dailyRequestAction', action: 'accept' });
    await send({ type: 'dailyRequestAction', bookingId: 'b-2' });
    await flush();

    expect(of('dailyActionResult')).toEqual([]);
  });

  test('a backend that throws is reported rather than swallowed', async () => {
    await boot();
    const ops = await import('../../backend/dailyOps.jsw');
    const original = ops.actOnDailyRequest;
    ops.actOnDailyRequest = () => Promise.reject(new Error('database down'));
    try {
      await send({ type: 'dailyRequestAction', bookingId: 'b-2', action: 'accept' });
      await flush();
    } finally {
      ops.actOnDailyRequest = original;
    }

    expect(last('dailyActionResult')).toEqual({
      type: 'dailyActionResult', success: false, message: 'database down',
    });
  });

  test('a result with no message still says something', async () => {
    await boot();
    const ops = await import('../../backend/dailyOps.jsw');
    const original = ops.actOnDailyRequest;
    ops.actOnDailyRequest = () => Promise.resolve({ success: true });
    try {
      await send({ type: 'dailyRequestAction', bookingId: 'b-2', action: 'accept' });
      await flush();
    } finally {
      ops.actOnDailyRequest = original;
    }

    expect(last('dailyActionResult')).toMatchObject({ success: true, message: 'Done' });
  });

  test('a failure with no message says the action failed', async () => {
    await boot();
    const ops = await import('../../backend/dailyOps.jsw');
    const original = ops.actOnDailyRequest;
    ops.actOnDailyRequest = () => Promise.resolve({ success: false });
    try {
      await send({ type: 'dailyRequestAction', bookingId: 'b-2', action: 'accept' });
      await flush();
    } finally {
      ops.actOnDailyRequest = original;
    }

    expect(last('dailyActionResult')).toMatchObject({ success: false, message: 'Action failed' });
  });

  test('the operator’s own session authorises the action, not anything in the message', async () => {
    const seen = [];
    await boot();
    const ops = await import('../../backend/dailyOps.jsw');
    const original = ops.actOnDailyRequest;
    ops.actOnDailyRequest = (args) => { seen.push(args); return original(args); };
    try {
      await send({
        type: 'dailyRequestAction', bookingId: 'b-2', action: 'accept',
        authToken: 'forged-token', sessionToken: 'forged-token',
      });
      await flush();
    } finally {
      ops.actOnDailyRequest = original;
    }

    expect(seen[0].authToken).not.toBe('forged-token');
    expect(seen[0].authToken).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the shell controls', () => {
  beforeEach(async () => { await boot(); });

  test('requestUserContext replies with the operator and the site base', async () => {
    const before = of('userContext').length;

    await send({ type: 'requestUserContext' });

    expect(of('userContext')).toHaveLength(before + 1);
    expect(last('userContext')).toMatchObject({
      name: 'A Operator',
      // The page sits at /site/myroom-daily, so the base is everything above it.
      siteBase: 'https://diamond.example/site',
    });
  });

  test('the user context is posted on load too', async () => {
    expect(of('userContext')).toHaveLength(1);
  });

  test('reload refreshes the board', async () => {
    const before = of('loadDailyOps').length;

    await send({ type: 'menuAction', action: 'reload' });
    await flush();

    expect(of('loadDailyOps')).toHaveLength(before + 1);
  });

  test('logout ends the session and returns to the backroom home', async () => {
    await send({ type: 'menuAction', action: 'logout' });

    expect(navigatedTo()).toEqual([APP_ROUTES.home]);
    expect(ctx.fake.rows('StaffSessions').every((s) => s.active === false)).toBe(true);
  });

  test('an unknown menu action does nothing', async () => {
    const before = html.posted.length;

    await send({ type: 'menuAction', action: 'explode' });
    await send({ type: 'menuAction' });

    expect(navigatedTo()).toEqual([]);
    expect(html.posted.length).toBe(before);
  });

  test.each([
    ['home', APP_ROUTES.home],
    ['daily', APP_ROUTES.daily],
    ['fleet', APP_ROUTES.fleet],
    ['bookings', APP_ROUTES.bookings],
    ['settings', APP_ROUTES.settings],
  ])('navigate %s goes to %s', async (route, target) => {
    await send({ type: 'navigate', route });

    expect(navigatedTo()).toEqual([target]);
  });

  test('an unknown route goes nowhere', async () => {
    await send({ type: 'navigate', route: 'contract' });
    await send({ type: 'navigate' });

    expect(navigatedTo()).toEqual([]);
  });

  test('resizeShell clamps to the board’s range', async () => {
    await send({ type: 'resizeShell', height: 3000 });
    expect(html.height).toBe(3000);

    await send({ type: 'resizeShell', height: 10 });
    expect(html.height).toBe(860);

    await send({ type: 'resizeShell', height: 99999 });
    expect(html.height).toBe(5200);
  });

  test('a resize with no usable height leaves the board as it was', async () => {
    await send({ type: 'resizeShell', height: 0 });
    await send({ type: 'resizeShell', height: 'tall' });
    await send({ type: 'resizeShell' });

    expect(html.height).toBe(1400);
  });

  test('an infinite height is refused rather than capped', async () => {
    await send('{"type":"resizeShell","height":1e999}');

    expect(html.height).toBe(1400);
  });

  test('a frame that rejects a resize is logged rather than crashing the page', async () => {
    await ctx.teardown();
    const stubborn = createComponent(COMP);
    let stored;
    Object.defineProperty(stubborn, 'height', {
      get() { return stored; },
      set(value) { if (value !== 1400) throw new Error('read only'); stored = value; },
    });
    await boot({ component: stubborn });

    await send({ type: 'resizeShell', height: 3000 });

    expect(warns).toHaveBeenCalledWith('[Daily View] resizeShell height set failed', 'read only');
  });
});

describe('the site base', () => {
  test.each([
    ['a nested page', 'https://diamond.example/site/myroom-daily', 'https://diamond.example/site'],
    ['a top-level page', 'https://diamond.example/myroom-daily', 'https://diamond.example'],
    ['a deeply nested page', 'https://diamond.example/a/b/myroom-daily', 'https://diamond.example/a/b'],
  ])('%s resolves to %s', async (_label, url, expected) => {
    await boot({ url });

    expect(last('userContext').siteBase).toBe(expected);
  });

  test('a URL that will not parse degrades to an empty base rather than failing', async () => {
    await boot({ url: 'not a url at all' });

    expect(last('userContext').siteBase).toBe('');
    expect(warns).toHaveBeenCalledWith('[Daily View] deriveSiteBase failed', expect.any(String));
  });
});

describe('what the board refuses to act on', () => {
  beforeEach(async () => { await boot(); });

  test('a message from an untrusted origin reaches nothing', async () => {
    const before = html.posted.length;
    await send({ type: 'requestDailyReload' }, 'https://evil.example');
    await send({ type: 'navigate', route: 'fleet' }, 'https://evil.example');
    await flush();

    expect(html.posted.length).toBe(before);
    expect(navigatedTo()).toEqual([]);
  });

  test('an origin-less message is accepted, even under the stricter spelling', async () => {
    // Written as `if (!isTrustedBridgeOrigin(...))` rather than `if (origin &&
    // !...)`, but isTrustedBridgeOrigin returns true for an empty origin, so the
    // two spellings agree today.
    await send({ type: 'navigate', route: 'fleet' }, '');

    expect(navigatedTo()).toEqual([APP_ROUTES.fleet]);
  });

  test('a trusted Wix suffix is accepted', async () => {
    await send({ type: 'navigate', route: 'fleet' }, 'https://diamond.wixsite.com');

    expect(navigatedTo()).toEqual([APP_ROUTES.fleet]);
  });

  test('an unparseable payload, a null payload and a typeless object do nothing', async () => {
    const before = html.posted.length;
    await send('{ not json');
    await send(null);
    await send({ route: 'fleet' });
    await flush();

    expect(html.posted.length).toBe(before);
    expect(navigatedTo()).toEqual([]);
  });

  test('an unrecognised message type does nothing', async () => {
    const before = html.posted.length;

    await send({ type: 'selfDestruct' });
    await flush();

    expect(html.posted.length).toBe(before);
    expect(navigatedTo()).toEqual([]);
  });

  // Two mutation survivors on this file, both equivalent:
  //
  // - Narrowing the payload guard to `if (!msg) return;` is undetectable, since
  //   every branch below re-tests msg.type against a literal.
  // - The focus booking id is trimmed twice — once when read from the query and
  //   again inside loadDailyOps — so removing either trim alone changes nothing.
});
