import { bootPageController, createComponent, staffSeed } from '../../../test/helpers/bootPageController.js';
import { derivePasswordHash, randomHex } from '../../backend/staffAccess.jsw';
import { APP_ROUTES } from '../../public/appRoutes.js';

// The fleet chart: a timeline of every vehicle against every booking, with
// drag-to-reassign. The page is gated at fleet/View while both of the actions
// it exposes — moving a booking to another vehicle, and auto-assigning one —
// demand fleet/Edit, so the page gate is again the weaker of the two.
//
// The state worth watching is `lastRange`. It is set from whatever the frame
// last asked for, and then used as the default for every subsequent load *and*
// as the date range stamped into four deep links. A load that fails must not
// leave it describing a range nobody asked for.

const COMP = '#fleetCalendarHtml';
const ADMIN = 'admin@example.com';
const VIEWER = 'viewer@example.com';
const OUTSIDER = 'pricing@example.com';
const PASSWORD = 'correct-horse-battery';
const TRUSTED = 'https://editor.wix.com';
const URL = 'https://diamond.example/myroom-fleetchart';
const FROM = '2026-03-10';
const TO = '2026-03-24';

function seed() {
  const salt = randomHex(16);
  const cred = (email) => ({
    _id: `cred-${email}`, email, passwordSalt: salt,
    passwordHash: derivePasswordHash(PASSWORD, salt), active: true,
  });
  const base = staffSeed(derivePasswordHash, randomHex, {
    email: ADMIN,
    password: PASSWORD,
    roles: [
      { _id: 'role-viewer', key: 'fleetviewer', label: 'Fleet viewer', active: true, fleetView: true, specialPermissions: '' },
      { _id: 'role-pricing', key: 'pricingonly', label: 'Pricing only', active: true, pricingView: true, specialPermissions: '' },
    ],
    users: [
      { _id: 'u-2', email: VIEWER, fullName: 'A Viewer', roleKey: 'fleetviewer', active: true },
      { _id: 'u-3', email: OUTSIDER, fullName: 'An Outsider', roleKey: 'pricingonly', active: true },
    ],
    extraCreds: [cred(VIEWER), cred(OUTSIDER)],
  });
  return {
    ...base,
    FleetNew: [
      { _id: 'f-1', fleetVehicleId: 'DRC-001', plate: 'AAA-1', model: 'Fiat Panda', category: 'ECO', active: true },
      { _id: 'f-2', fleetVehicleId: 'DRC-002', plate: 'BBB-2', model: 'VW Polo', category: 'ECO', active: true },
    ],
    VehiclesNew: [{ _id: 'cat-1', category: 'ECO', title: 'Economy', active: true }],
    BookingsNew: [
      {
        _id: 'b-1', bookingNumber: 'BK-1', status: 'Confirmed', rentalState: 'Booking',
        customerName: 'A Guest', assignedVehicle: 'f-1',
        pickupDateTime: `${FROM}T09:00:00.000Z`, dropoffDateTime: `${FROM}T18:00:00.000Z`,
      },
      {
        _id: 'b-2', bookingNumber: 'BK-2', status: 'Pending', rentalState: 'Booking',
        customerName: 'B Guest',
        pickupDateTime: '2026-03-12T09:00:00.000Z', dropoffDateTime: '2026-03-13T09:00:00.000Z',
      },
      {
        _id: 'b-3', bookingNumber: 'BK-3', status: 'Confirmed', rentalState: 'Active Rental',
        customerName: 'C Guest', assignedVehicle: 'f-2',
        pickupDateTime: '2026-03-11T09:00:00.000Z', dropoffDateTime: '2026-03-15T09:00:00.000Z',
      },
    ],
    RentalsNew: [],
  };
}

let ctx;
let html;
let warns;

async function boot({ signInAs = ADMIN, query = {}, bare = false, component = null, extras = {} } = {}) {
  html = component || createComponent(COMP);
  ctx = await bootPageController({
    importer: () => import('../Fleet Chart.ed11o.js'),
    components: bare ? {} : { [COMP]: html, ...extras },
    seed: seed(),
    signInAs,
    password: PASSWORD,
    query,
    url: URL,
    path: ['myroom-fleetchart'],
  });
  await flush();
  return ctx;
}

const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
const send = (msg, origin = TRUSTED) => html.emitMessage({ origin, data: msg });
const of = (type) => html.postedOfType(type);
const last = (type) => of(type).pop();
const toasts = () => of('toast').map((t) => t.message);
const navigatedTo = () => ctx.wixLocation.to.mock.calls.map((c) => c[0]);
const settleFocus = async () => { jest.advanceTimersByTime(220); await flush(); };
/** Puts a known range into lastRange, the way the frame does on first paint. */
const setRange = async (from = FROM, to = TO) => {
  await send({ type: 'calendarReady', from, to });
  await flush();
};

beforeEach(() => { warns = jest.spyOn(console, 'warn').mockImplementation(() => {}); });

afterEach(async () => {
  if (ctx) await ctx.teardown();
  ctx = null;
  html = null;
  warns.mockRestore();
});

describe('the access guard', () => {
  test('an operator with fleet access gets the chart', async () => {
    await boot();

    expect(html.expanded).toBe(1);
    expect(html.shown).toBe(1);
    expect(html.height).toBe(1250);
    expect(of('resume')).toHaveLength(1);
    expect(last('loadData')).toBeTruthy();
  });

  test('a signed-out visitor is bounced carrying where they were headed', async () => {
    await boot({ signInAs: null });

    expect(navigatedTo()).toEqual([`${APP_ROUTES.home}?next=${encodeURIComponent('/myroom-fleetchart')}`]);
    expect(html.posted).toEqual([]);
  });

  test('a signed-in operator with no fleet permission is bounced and marked as denied', async () => {
    await boot({ signInAs: OUTSIDER });

    expect(navigatedTo()).toEqual([
      `${APP_ROUTES.home}?next=${encodeURIComponent('/myroom-fleetchart')}&denied=1`,
    ]);
  });

  test('a view-only operator is let in — the page gate is View, not Edit', async () => {
    await boot({ signInAs: VIEWER });

    expect(navigatedTo()).toEqual([]);
    expect(last('loadData')).toBeTruthy();
  });

  test('a page with no frame does nothing beyond the guard', async () => {
    await boot({ bare: true });

    expect(navigatedTo()).toEqual([]);
  });

  test('sibling frames are collapsed and the chart is spared', async () => {
    const stray = createComponent('#legacyHtml');
    await boot({ extras: { '#legacyHtml': stray } });

    expect(stray.collapsed).toBe(1);
    expect(stray.hidden).toBe(1);
    expect(html.collapsed).toBe(0);
  });

  test('a frame that refuses to expand is still wired up', async () => {
    const stubborn = createComponent(COMP, { expand() { throw new Error('locked'); } });
    await boot({ component: stubborn });

    expect(warns).toHaveBeenCalledWith('[Fleet Chart] expand/show failed', 'locked');
    expect(last('loadData')).toBeTruthy();
  });

  test('a frame that refuses the opening height is logged', async () => {
    const stubborn = createComponent(COMP);
    Object.defineProperty(stubborn, 'height', {
      get() { return undefined; },
      set() { throw new Error('read only'); },
    });
    await boot({ component: stubborn });

    expect(warns).toHaveBeenCalledWith('[Fleet Chart] initial height set failed', 'read only');
  });
});

describe('loading the chart', () => {
  test('the vehicles, their bookings and the unassigned queue arrive together', async () => {
    await boot();

    const payload = last('loadData');
    expect(payload.groups.length).toBeGreaterThan(0);
    expect(payload.items.length).toBeGreaterThan(0);
    expect(payload.unassigned.map((u) => u.id)).toContain('b-2');
  });

  test.each(['calendarReady', 'requestReload'])('%s reloads the chart for the range it names', async (type) => {
    const seen = [];
    await boot();
    const fleet = await import('../../backend/fleetCalendar.jsw');
    const original = fleet.getFleetCalendarData;
    fleet.getFleetCalendarData = (args) => { seen.push(args); return original(args); };
    try {
      await send({ type, from: FROM, to: TO });
      await flush();
    } finally {
      fleet.getFleetCalendarData = original;
    }

    expect(seen[0]).toMatchObject({ from: FROM, to: TO });
    expect(of('loadData')).toHaveLength(2);
  });

  test('a reload with no range reuses the one the frame last asked for', async () => {
    const seen = [];
    await boot();
    await setRange();
    const fleet = await import('../../backend/fleetCalendar.jsw');
    const original = fleet.getFleetCalendarData;
    fleet.getFleetCalendarData = (args) => { seen.push(args); return original(args); };
    try {
      await send({ type: 'requestReload' });
      await flush();
    } finally {
      fleet.getFleetCalendarData = original;
    }

    expect(seen[0]).toMatchObject({ from: FROM, to: TO });
  });

  test('a failing load shows the error rather than an empty chart', async () => {
    await boot();
    const fleet = await import('../../backend/fleetCalendar.jsw');
    const original = fleet.getFleetCalendarData;
    fleet.getFleetCalendarData = () => Promise.reject(new Error('calendar offline'));
    try {
      await send({ type: 'requestReload' });
      await flush();
    } finally {
      fleet.getFleetCalendarData = original;
    }

    expect(last('showError')).toEqual({ type: 'showError', message: 'calendar offline' });
    expect(of('loadData')).toHaveLength(1);
  });

  test('a failed jump still adopts the range that failed', async () => {
    // Pinned as it behaves. loadCalendar only writes lastRange after a
    // successful fetch, but the calendarReady/requestReload handler has already
    // written it before calling loadCalendar — so a range that never loaded
    // becomes the range every deep link afterwards stamps into its URL.
    await boot();
    await setRange();
    const fleet = await import('../../backend/fleetCalendar.jsw');
    const original = fleet.getFleetCalendarData;
    fleet.getFleetCalendarData = () => Promise.reject(new Error('calendar offline'));
    try {
      await send({ type: 'requestReload', from: '2026-06-01', to: '2026-06-30' });
      await flush();
    } finally {
      fleet.getFleetCalendarData = original;
    }

    await send({ type: 'openContract', bookingId: 'b-1' });

    expect(navigatedTo()[0]).toContain('startDate=2026-06-01&endDate=2026-06-30');
  });

  test('a backend answering with nothing usable still produces empty lists', async () => {
    await boot();
    const fleet = await import('../../backend/fleetCalendar.jsw');
    const original = fleet.getFleetCalendarData;
    fleet.getFleetCalendarData = () => Promise.resolve({ groups: 'nope', items: null });
    try {
      await send({ type: 'requestReload' });
      await flush();
    } finally {
      fleet.getFleetCalendarData = original;
    }

    expect(last('loadData')).toMatchObject({ groups: [], items: [], unassigned: [] });
  });
});

describe('the deferred focus', () => {
  test('a bookingId in the query is echoed back once the chart has loaded', async () => {
    await boot({ query: { bookingId: 'b-1' } });

    expect(of('focusBooking')).toEqual([]);
    jest.advanceTimersByTime(179);
    await flush();
    expect(of('focusBooking')).toEqual([]);

    await settleFocus();

    expect(last('focusBooking')).toEqual({ type: 'focusBooking', bookingId: 'b-1' });
  });

  test('the focus is sent once and not repeated on later reloads', async () => {
    await boot({ query: { bookingId: 'b-1' } });
    await settleFocus();
    expect(of('focusBooking')).toHaveLength(1);

    await send({ type: 'requestReload' });
    await flush();
    await settleFocus();

    expect(of('focusBooking')).toHaveLength(1);
  });

  test.each([
    ['no bookingId', {}],
    ['a whitespace-only bookingId', { bookingId: '   ' }],
  ])('%s means no focus message', async (_label, query) => {
    await boot({ query });
    await settleFocus();

    expect(of('focusBooking')).toEqual([]);
  });

  test('the frame can ask for a focus directly, and gets it straight back', async () => {
    await boot();

    await send({ type: 'focusBooking', bookingId: 'b-3' });

    expect(last('focusBooking')).toEqual({ type: 'focusBooking', bookingId: 'b-3' });
  });
});

describe('moving a booking to another vehicle', () => {
  test('a permitted move is written and the chart patched rather than reloaded', async () => {
    await boot();

    await send({ type: 'moveBooking', bookingId: 'b-1', newVehicleId: 'f-2' });
    await flush();

    expect(ctx.fake.rows('BookingsNew').find((b) => b._id === 'b-1').assignedVehicle).toBe('f-2');
    // A patch, not a full load: the frame keeps its scroll position.
    expect(of('patchItems')).toHaveLength(1);
    expect(of('moveRejected')).toEqual([]);
  });

  test('a booking already out on rental is refused, and the frame told why', async () => {
    await boot();

    await send({ type: 'moveBooking', bookingId: 'b-3', newVehicleId: 'f-1' });
    await flush();

    expect(last('moveRejected')).toEqual({
      type: 'moveRejected', bookingId: 'b-3', reason: 'LockedRentalState',
    });
    expect(toasts()).toContain('Move rejected: LockedRentalState');
    expect(ctx.fake.rows('BookingsNew').find((b) => b._id === 'b-3').assignedVehicle).toBe('f-2');
  });

  test('a view-only operator’s move is refused, and the frame is told why', async () => {
    // The backend refuses a move in two shapes: a business rule returns
    // { success:false }, a permission failure throws. Only the first used to be
    // handled, so this drag silently snapped back with no explanation — for
    // exactly the operators most likely to attempt it. Both shapes now reach
    // the frame the same way.
    await boot({ signInAs: VIEWER });

    await send({ type: 'moveBooking', bookingId: 'b-1', newVehicleId: 'f-2' });
    await flush();

    expect(last('moveRejected')).toEqual({
      type: 'moveRejected', bookingId: 'b-1', reason: 'ACCESS_DENIED',
    });
    expect(toasts()).toContain('Move rejected: ACCESS_DENIED');
    expect(ctx.fake.rows('BookingsNew').find((b) => b._id === 'b-1').assignedVehicle).toBe('f-1');
  });

  test('a view-only operator’s auto-assign is reported too', async () => {
    await boot({ signInAs: VIEWER });

    await send({ type: 'autoAssignSingle', bookingId: 'b-2' });
    await flush();

    expect(toasts()).toContain('Auto-assign failed: ACCESS_DENIED');
    expect(ctx.fake.rows('BookingsNew').find((b) => b._id === 'b-2').status).toBe('Pending');
  });

  test('a bulk auto-assign refused on permissions reaches the frame as well', async () => {
    // autoAssignRange always wrapped its work; the two single-booking paths now
    // match it, so all three report the same refusal the same way.
    await boot({ signInAs: VIEWER });

    await send({ type: 'autoAssignUnassigned', from: FROM, to: TO });
    await flush();

    expect(toasts()).toContain('Auto-assign failed: ACCESS_DENIED');
  });

  test('a move that throws something with no message still names the failure', async () => {
    await boot();
    const fleet = await import('../../backend/fleetCalendar.jsw');
    const original = fleet.moveBookingVehicleOnly;
    fleet.moveBookingVehicleOnly = () => Promise.reject('just a string');
    try {
      await send({ type: 'moveBooking', bookingId: 'b-1', newVehicleId: 'f-2' });
      await flush();
    } finally {
      fleet.moveBookingVehicleOnly = original;
    }

    expect(last('moveRejected').reason).toBe('just a string');
  });

  test('an auto-assign that throws something with no message still names the failure', async () => {
    await boot();
    const fleet = await import('../../backend/fleetCalendar.jsw');
    const original = fleet.confirmAndAutoAssign;
    fleet.confirmAndAutoAssign = () => Promise.reject('just a string');
    try {
      await send({ type: 'autoAssignSingle', bookingId: 'b-2' });
      await flush();
    } finally {
      fleet.confirmAndAutoAssign = original;
    }

    expect(toasts()).toContain('Auto-assign failed: just a string');
  });

  test('a refused move still refreshes nothing, so the chart keeps what it had', async () => {
    await boot({ signInAs: VIEWER });
    const before = of('patchItems').length;

    await send({ type: 'moveBooking', bookingId: 'b-1', newVehicleId: 'f-2' });
    await flush();

    expect(of('patchItems')).toHaveLength(before);
  });

  test('a move naming no booking or no vehicle is refused', async () => {
    await boot();

    await send({ type: 'moveBooking', newVehicleId: 'f-2' });
    await flush();

    expect(last('moveRejected')).toMatchObject({ bookingId: '', reason: 'MissingParams' });
  });

  test('a rejection with no message still says something', async () => {
    await boot();
    const fleet = await import('../../backend/fleetCalendar.jsw');
    const original = fleet.moveBookingVehicleOnly;
    fleet.moveBookingVehicleOnly = () => Promise.resolve({ success: false });
    try {
      await send({ type: 'moveBooking', bookingId: 'b-1', newVehicleId: 'f-2' });
      await flush();
    } finally {
      fleet.moveBookingVehicleOnly = original;
    }

    expect(last('moveRejected').reason).toBe('Move failed');
    expect(toasts()).toContain('Move rejected: failed');
  });

  test('the move is authorised by the operator’s session, not by anything in the message', async () => {
    const seen = [];
    await boot();
    const fleet = await import('../../backend/fleetCalendar.jsw');
    const original = fleet.moveBookingVehicleOnly;
    fleet.moveBookingVehicleOnly = (args) => { seen.push(args); return original(args); };
    try {
      await send({ type: 'moveBooking', bookingId: 'b-1', newVehicleId: 'f-2', authToken: 'forged' });
      await flush();
    } finally {
      fleet.moveBookingVehicleOnly = original;
    }

    expect(seen[0].authToken).not.toBe('forged');
    expect(seen[0].authToken).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('auto-assigning', () => {
  test('a single booking is confirmed and given a vehicle', async () => {
    await boot();

    await send({ type: 'autoAssignSingle', bookingId: 'b-2' });
    await flush();

    expect(toasts()).toContain('Vehicle auto-assigned');
    expect(ctx.fake.rows('BookingsNew').find((b) => b._id === 'b-2').status).toBe('Confirmed');
    expect(of('patchItems')).toHaveLength(1);
  });

  test('a confirmation with no vehicle available says so', async () => {
    await boot();
    const fleet = await import('../../backend/fleetCalendar.jsw');
    const original = fleet.confirmAndAutoAssign;
    fleet.confirmAndAutoAssign = () => Promise.resolve({ success: true, assigned: false });
    try {
      await send({ type: 'autoAssignSingle', bookingId: 'b-2' });
      await flush();
    } finally {
      fleet.confirmAndAutoAssign = original;
    }

    expect(toasts()).toContain('Confirmed without assignment');
  });

  test('a failure names the reason', async () => {
    await boot();

    await send({ type: 'autoAssignSingle' });
    await flush();

    expect(toasts()).toContain('Auto-assign failed: MissingParams');
  });

  test('a failure with no message still says something', async () => {
    await boot();
    const fleet = await import('../../backend/fleetCalendar.jsw');
    const original = fleet.confirmAndAutoAssign;
    fleet.confirmAndAutoAssign = () => Promise.resolve({ success: false });
    try {
      await send({ type: 'autoAssignSingle', bookingId: 'b-2' });
      await flush();
    } finally {
      fleet.confirmAndAutoAssign = original;
    }

    expect(toasts()).toContain('Auto-assign failed: error');
  });

  test('the whole unassigned queue can be assigned in one go, and the count reported', async () => {
    await boot();

    await send({ type: 'autoAssignUnassigned', from: FROM, to: TO });
    await flush();

    expect(toasts()).toContain('Auto-assigned 1 booking(s)');
    expect(ctx.fake.rows('BookingsNew').find((b) => b._id === 'b-2').status).toBe('Confirmed');
    // Refreshed afterwards, or the assigned bookings would stay in the
    // unassigned tray until the operator reloaded by hand.
    expect(of('patchItems')).toHaveLength(1);
  });

  test('the range the bulk assign ran over becomes the chart’s range', async () => {
    await boot();
    await setRange();

    await send({ type: 'autoAssignUnassigned', from: '2026-05-01', to: '2026-05-31' });
    await flush();
    await send({ type: 'openContract', bookingId: 'b-1' });

    expect(navigatedTo()[0]).toContain('startDate=2026-05-01&endDate=2026-05-31');
  });

  test('an unassigned payload that is not a list is treated as empty, not iterated', async () => {
    // A truthy non-list is what separates the Array.isArray check from a bare
    // `|| []`: a for...of over a plain object throws, and the operator would be
    // shown a TypeError instead of "nothing to do".
    await boot();
    const fleet = await import('../../backend/fleetCalendar.jsw');
    const original = fleet.getFleetCalendarData;
    fleet.getFleetCalendarData = () => Promise.resolve({ unassigned: { id: 'b-2' } });
    try {
      await send({ type: 'autoAssignUnassigned', from: FROM, to: TO });
      await flush();
    } finally {
      fleet.getFleetCalendarData = original;
    }

    expect(toasts()).toContain('No unassigned bookings to auto-assign');
  });

  test('an empty queue says there was nothing to do', async () => {
    await boot();
    const fleet = await import('../../backend/fleetCalendar.jsw');
    const original = fleet.getFleetCalendarData;
    fleet.getFleetCalendarData = () => Promise.resolve({ groups: [], items: [], unassigned: [] });
    try {
      await send({ type: 'autoAssignUnassigned', from: FROM, to: TO });
      await flush();
    } finally {
      fleet.getFleetCalendarData = original;
    }

    expect(toasts()).toContain('No unassigned bookings to auto-assign');
  });

  test('entries with no id are skipped rather than sent as blanks', async () => {
    const seen = [];
    await boot();
    const fleet = await import('../../backend/fleetCalendar.jsw');
    const originalData = fleet.getFleetCalendarData;
    const originalAssign = fleet.confirmAndAutoAssign;
    fleet.getFleetCalendarData = () => Promise.resolve({ unassigned: [{ id: '' }, {}, { id: 'b-2' }] });
    fleet.confirmAndAutoAssign = (args) => { seen.push(args.bookingId); return Promise.resolve({ success: true }); };
    try {
      await send({ type: 'autoAssignUnassigned', from: FROM, to: TO });
      await flush();
    } finally {
      fleet.getFleetCalendarData = originalData;
      fleet.confirmAndAutoAssign = originalAssign;
    }

    expect(seen).toEqual(['b-2']);
    expect(toasts()).toContain('Auto-assigned 1 booking(s)');
  });

  test('only the successes are counted', async () => {
    await boot();
    const fleet = await import('../../backend/fleetCalendar.jsw');
    const originalData = fleet.getFleetCalendarData;
    const originalAssign = fleet.confirmAndAutoAssign;
    fleet.getFleetCalendarData = () => Promise.resolve({ unassigned: [{ id: 'b-2' }, { id: 'b-9' }] });
    fleet.confirmAndAutoAssign = ({ bookingId }) => Promise.resolve({ success: bookingId === 'b-2' });
    try {
      await send({ type: 'autoAssignUnassigned', from: FROM, to: TO });
      await flush();
    } finally {
      fleet.getFleetCalendarData = originalData;
      fleet.confirmAndAutoAssign = originalAssign;
    }

    expect(toasts()).toContain('Auto-assigned 1 booking(s)');
  });

  test('a failure part-way through is reported rather than swallowed', async () => {
    await boot();
    const fleet = await import('../../backend/fleetCalendar.jsw');
    const original = fleet.getFleetCalendarData;
    fleet.getFleetCalendarData = () => Promise.reject(new Error('calendar offline'));
    try {
      await send({ type: 'autoAssignUnassigned', from: FROM, to: TO });
      await flush();
    } finally {
      fleet.getFleetCalendarData = original;
    }

    expect(toasts()).toContain('Auto-assign failed: calendar offline');
  });
});

describe('the deep links out', () => {
  beforeEach(async () => {
    await boot();
    await setRange();
  });

  test('openOnDaily carries the booking, the day and the view it wants', async () => {
    await send({ type: 'openOnDaily', bookingId: 'b-1', date: '2026-03-12', viewMode: 'compact', tab: 'checkin' });

    expect(navigatedTo()).toEqual([
      `${APP_ROUTES.daily}?bookingId=b-1&date=2026-03-12&view=compact&tab=checkin&from=fleet`,
    ]);
  });

  test('openOnBookings takes its end date from the start when the chart has never had one', async () => {
    await ctx.teardown();
    await boot();
    await send({ type: 'calendarReady', from: FROM });
    await flush();

    await send({ type: 'openOnBookings', bookingId: 'b-1' });

    expect(navigatedTo()[0]).toContain(`startDate=${FROM}&endDate=${FROM}`);
  });

  test('openOnDaily falls back to the chart’s own start date and the default view', async () => {
    await send({ type: 'openOnDaily', bookingId: 'b-1' });

    expect(navigatedTo()).toEqual([
      `${APP_ROUTES.daily}?bookingId=b-1&date=${FROM}&view=full&tab=bookings&from=fleet`,
    ]);
  });

  test('openOnDaily with a malformed date falls back rather than passing it on', async () => {
    await send({ type: 'openOnDaily', bookingId: 'b-1', date: '12/03/2026' });

    expect(navigatedTo()[0]).toContain(`date=${FROM}`);
  });

  test('openOnBookings carries the booking and the chart’s range', async () => {
    await send({ type: 'openOnBookings', bookingId: 'b-1' });

    expect(navigatedTo()).toEqual([
      `${APP_ROUTES.bookings}?bookingId=b-1&startDate=${FROM}&endDate=${TO}&from=fleet`,
    ]);
  });

  test('a range field left empty keeps whatever the chart last had', async () => {
    // `to: String(msg.to || lastRange.to || '')` — an omitted bound is sticky
    // rather than cleared, so the frame can send a partial range.
    await send({ type: 'requestReload', from: '2026-04-01' });
    await flush();

    await send({ type: 'openOnBookings', bookingId: 'b-1' });

    expect(navigatedTo()[0]).toContain(`startDate=2026-04-01&endDate=${TO}`);
  });

  test('openOnBookings without a booking still opens the board', async () => {
    await send({ type: 'openOnBookings' });

    expect(navigatedTo()[0]).not.toContain('bookingId=');
    expect(navigatedTo()[0]).toContain('from=fleet');
  });

  test('openContract carries the booking, the origin and the range', async () => {
    await send({ type: 'openContract', bookingId: 'b-1' });

    expect(navigatedTo()).toEqual([
      `${APP_ROUTES.contract}?bookingId=b-1&from=fleet&startDate=${FROM}&endDate=${TO}`,
    ]);
  });

  test('openContract with no booking goes nowhere', async () => {
    await send({ type: 'openContract' });

    expect(navigatedTo()).toEqual([]);
  });

  test('openVehicleCard carries the vehicle, the origin and the range', async () => {
    await send({ type: 'openVehicleCard', fleetVehicleId: 'DRC-001' });

    expect(navigatedTo()).toEqual([
      `${APP_ROUTES.vehiclecard}?fleetVehicleId=DRC-001&from=fleet&startDate=${FROM}&endDate=${TO}`,
    ]);
  });

  test('openVehicleCard accepts the vehicleId spelling and carries a booking when given one', async () => {
    await send({ type: 'openVehicleCard', vehicleId: 'DRC-002', bookingId: 'b-3' });

    expect(navigatedTo()[0]).toContain('fleetVehicleId=DRC-002');
    expect(navigatedTo()[0]).toContain('bookingId=b-3');
  });

  test.each([
    ['openVehicleCard', { fleetVehicleId: '   ' }],
    ['openVehicleCard', {}],
  ])('%s with no vehicle goes nowhere', async (type, extra) => {
    await send({ type, ...extra });

    expect(navigatedTo()).toEqual([]);
  });

  test('a booking id needing escaping is encoded', async () => {
    await send({ type: 'openContract', bookingId: 'B 1&x=2' });

    expect(navigatedTo()[0]).toContain('bookingId=B+1%26x%3D2');
  });
});

describe('the shell controls', () => {
  beforeEach(async () => { await boot(); });

  test('requestUserContext replies with the operator', async () => {
    const before = of('userContext').length;

    await send({ type: 'requestUserContext' });

    expect(of('userContext')).toHaveLength(before + 1);
    expect(last('userContext')).toMatchObject({ name: 'A Operator' });
  });

  test('the user context is posted on load too', async () => {
    expect(of('userContext')).toHaveLength(1);
  });

  test('reload refreshes the chart in full', async () => {
    await send({ type: 'menuAction', action: 'reload' });
    await flush();

    expect(of('loadData')).toHaveLength(2);
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

  test('resizeShell clamps to the chart’s range', async () => {
    await send({ type: 'resizeShell', height: 3000 });
    expect(html.height).toBe(3000);

    await send({ type: 'resizeShell', height: 10 });
    expect(html.height).toBe(900);

    await send({ type: 'resizeShell', height: 99999 });
    expect(html.height).toBe(5000);
  });

  test('a resize with no usable height leaves the chart as it was', async () => {
    await send({ type: 'resizeShell', height: 0 });
    await send({ type: 'resizeShell', height: 'tall' });
    await send({ type: 'resizeShell' });
    await send('{"type":"resizeShell","height":1e999}');

    expect(html.height).toBe(1250);
  });

  test('a frame that rejects a resize is logged rather than crashing the page', async () => {
    await ctx.teardown();
    const stubborn = createComponent(COMP);
    let stored;
    Object.defineProperty(stubborn, 'height', {
      get() { return stored; },
      set(value) { if (value !== 1250) throw new Error('read only'); stored = value; },
    });
    await boot({ component: stubborn });

    await send({ type: 'resizeShell', height: 3000 });

    expect(warns).toHaveBeenCalledWith('[Fleet Chart] resizeShell height set failed', 'read only');
  });
});

describe('what the chart refuses to act on', () => {
  beforeEach(async () => { await boot(); });

  test('a message from an untrusted origin reaches nothing', async () => {
    const before = html.posted.length;
    await send({ type: 'requestReload' }, 'https://evil.example');
    await send({ type: 'moveBooking', bookingId: 'b-1', newVehicleId: 'f-2' }, 'https://evil.example');
    await flush();

    expect(html.posted.length).toBe(before);
    expect(ctx.fake.rows('BookingsNew').find((b) => b._id === 'b-1').assignedVehicle).toBe('f-1');
  });

  test('an origin-less message is accepted', async () => {
    await send({ type: 'navigate', route: 'daily' }, '');

    expect(navigatedTo()).toEqual([APP_ROUTES.daily]);
  });

  test('an unparseable payload, a null payload and a typeless object do nothing', async () => {
    const before = html.posted.length;
    await send('{ not json');
    await send(null);
    await send({ route: 'daily' });
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

  // One mutation survivor on this file, verified equivalent: narrowing the
  // payload guard to `if (!msg) return;` is undetectable, because every branch
  // below re-tests msg.type against a literal.
});
