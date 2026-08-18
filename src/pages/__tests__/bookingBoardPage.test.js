import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { installPageEnv, createComponent } from '../../../test/helpers/fakePageEnv.js';
import { APP_ROUTES } from '../../public/appRoutes.js';

// The first test of a Velo page controller. These are top-level scripts that
// register a $w.onReady callback and reach components through a $w global, so
// test/helpers/fakePageEnv installs that global, imports the module, and runs
// the callback.
//
// The Booking Board page is worth going first: it is a message router. Anything
// the embedded UI posts can reach a backend call, a navigation or a sign-out,
// and the only thing standing in front of that is the origin check. Nothing in
// src/pages had a test.

const HTML_ID = '#bookingsHtml';
const STAFF = 'staff@example.com';
const VIEWER = 'viewer@example.com';
const PASSWORD = 'correct-horse-battery';
const TRUSTED = 'https://editor.wix.com';

function credential(email, hash, hex) {
  const passwordSalt = hex(16);
  return {
    _id: `cred-${email}`, email, passwordSalt,
    passwordHash: hash(PASSWORD, passwordSalt), active: true,
  };
}

function booking(over = {}) {
  return {
    _id: 'bk-1',
    bookingNumber: 'RNT-2026-0001',
    status: 'Pending',
    customerName: 'A Customer',
    pickupDateTime: new Date().toISOString(),
    dropoffDateTime: new Date(Date.now() + 3 * 86400000).toISOString(),
    totalPrice: 208,
    ...over,
  };
}

function seed(hash, hex, extra = {}) {
  return {
    StaffRoles: [
      { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true },
      // Can see the board but nothing else; used to prove the guard runs.
      { _id: 'role-none', key: 'none', label: 'No access', active: true, specialPermissions: '' },
    ],
    StaffUsers: [
      { _id: 'u-1', email: STAFF, fullName: 'A Operator', roleKey: 'admin', active: true },
      { _id: 'u-2', email: VIEWER, fullName: 'No Access', roleKey: 'none', active: true },
    ],
    StaffCredentials: [credential(STAFF, hash, hex), credential(VIEWER, hash, hex)],
    StaffSessions: [],
    StaffAuditLog: [],
    BookingsNew: [booking()],
    FleetNew: [],
    ...extra,
  };
}

let fake;
let env;
let html;
let other;
let wixLocation;
let wixData;

/**
 * Boots the page as a signed-in operator unless told otherwise.
 *
 * Everything is imported dynamically, after jest.resetModules(), so the page
 * controller and this test share one module registry. Importing wix-location at
 * the top of the file instead would hand the controller a different copy, and
 * nothing set up here would reach it — which is exactly what happened first
 * time round.
 */
async function boot({ email = STAFF, query = {}, url = 'https://diamond.example/site/myroom-bookingboard', seedData } = {}) {
  jest.resetModules();
  // The clock is fake for every test in this file. loadBoard defers a
  // focusBooking post by 120ms, and a real timer left pending outlives the
  // test — it then fires against a torn-down environment and fails the whole
  // run. It did exactly that in CI while passing locally, because whether the
  // timer lands before or after teardown is a matter of machine speed.
  jest.useFakeTimers({ now: new Date('2026-03-10T12:00:00.000Z') });

  wixLocation = (await import('wix-location')).default;
  wixData = (await import('wix-data')).default;
  const { local, session } = await import('wix-storage');
  const { loginStaff, derivePasswordHash: hash, randomHex: hex } = await import('../../backend/staffAccess.jsw');
  const { storeSessionToken } = await import('../../public/backroomAuth.js');

  local.clear();
  session.clear();

  fake = createFakeWixData(seedData || seed(hash, hex)).install(wixData);
  if (email) {
    const { sessionToken } = await loginStaff({ email, password: PASSWORD });
    storeSessionToken(sessionToken, true);
  }
  wixLocation.query = query;
  wixLocation.url = url;
  wixLocation.path = ['myroom-bookingboard'];
  wixLocation.to = jest.fn();

  html = createComponent(HTML_ID);
  // A second HtmlComponent, so the page has a sibling to collapse. With only
  // the board's own component present there is nothing for hideOtherComponents
  // to act on and its call cannot be observed at all.
  other = createComponent('#leftoverHtml');
  env = installPageEnv({ [HTML_ID]: html, '#leftoverHtml': other });
  await env.start(() => import('../Booking Board.vjirh.js'));
  return html;
}

/** Delivers a message from the embedded UI, from a trusted origin by default. */
const send = (msg, origin = TRUSTED) => html.emitMessage({ origin, data: msg });

/** Lets the page's deferred focusBooking post run, within the test's lifetime. */
async function flushDeferred() {
  jest.runOnlyPendingTimers();
  await Promise.resolve();
}

afterEach(() => {
  // Drain anything still scheduled while $w is still installed, so nothing can
  // reach into a torn-down environment.
  if (env) {
    jest.runOnlyPendingTimers();
    env.restore();
  }
  env = null;
  if (fake) fake.restore();
  fake = null;
  jest.useRealTimers();
});

describe('booting the page', () => {
  test('runs the access guard before showing anything', async () => {
    await boot({ email: null });
    expect(wixLocation.to).toHaveBeenCalled();
    expect(html.shown).toBe(0);
    expect(html.posted).toHaveLength(0);
  });

  test('a signed-in operator without board access is redirected, not shown the board', async () => {
    await boot({ email: VIEWER });
    expect(wixLocation.to.mock.calls[0][0]).toContain('denied=1');
    expect(html.posted).toHaveLength(0);
  });

  test('a permitted operator gets the component expanded and shown', async () => {
    await boot();
    expect(html.expanded).toBe(1);
    expect(html.shown).toBe(1);
  });

  test('every other HtmlComponent on the page is collapsed and hidden', async () => {
    // A backroom page embeds one component and has to get the rest out of the
    // way, or a leftover from the editor renders underneath the board.
    await boot();
    expect(other.collapsed).toBe(1);
    expect(other.hidden).toBe(1);
    expect(html.collapsed).toBe(0);
    expect(html.hidden).toBe(0);
  });

  test('the page announces itself and hands over the user context', async () => {
    await boot();
    expect(html.postedOfType('resume')).toHaveLength(1);
    const [context] = html.postedOfType('userContext');
    expect(context).toMatchObject({ name: 'A Operator', role: 'Admin' });
  });

  test('the board data is loaded on open', async () => {
    await boot();
    const [load] = html.postedOfType('loadBookings');
    expect(load.items.map((i) => i._id)).toEqual(['bk-1']);
  });

  test('a booking named in the url is focused after the board loads', async () => {
    await boot({ query: { bookingId: 'bk-1' } });
    expect(html.postedOfType('focusBooking')).toHaveLength(0);
    await flushDeferred();
    expect(html.postedOfType('focusBooking').pop()).toEqual({ type: 'focusBooking', bookingId: 'bk-1' });
  });

  test('with no booking in the url nothing is focused', async () => {
    await boot();
    await flushDeferred();
    expect(html.postedOfType('focusBooking')).toHaveLength(0);
  });

  test('the site base is derived from the page url, minus the page segment', async () => {
    await boot({ url: 'https://diamond.example/site/myroom-bookingboard' });
    expect(html.postedOfType('userContext')[0].siteBase).toBe('https://diamond.example/site');
  });

  test('a page at the site root uses the origin as the base', async () => {
    await boot({ url: 'https://diamond.example/myroom-bookingboard' });
    expect(html.postedOfType('userContext')[0].siteBase).toBe('https://diamond.example');
  });

  test('an unparseable url leaves the base empty rather than failing the page', async () => {
    await boot({ url: 'not a url' });
    expect(html.postedOfType('userContext')[0].siteBase).toBe('');
    expect(html.postedOfType('loadBookings')).toHaveLength(1);
  });
});

describe('the origin check in front of the router', () => {
  test('a message from an untrusted origin is ignored entirely', async () => {
    await boot();
    const before = html.posted.length;

    await send({ type: 'menuAction', action: 'logout' }, 'https://evil.example');

    expect(html.posted).toHaveLength(before);
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('a near-miss host is untrusted too', async () => {
    await boot();
    await send({ type: 'navigate', route: 'home' }, 'https://notwix.com');
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('a message from the page\'s own host is trusted', async () => {
    await boot({ url: 'https://diamond.example/site/myroom-bookingboard' });
    await send({ type: 'navigate', route: 'home' }, 'https://diamond.example');
    expect(wixLocation.to).toHaveBeenCalledWith(APP_ROUTES.home);
  });

  test('a message with no type is ignored', async () => {
    // The explicit guard is belt-and-braces rather than the thing doing the
    // work: every branch below dispatches on msg.type, so a message without one
    // falls through them all and does nothing regardless. Pinned as behaviour.
    await boot();
    const before = html.posted.length;
    await send({ noType: true });
    await send(null);
    await send('not json');
    await send(JSON.stringify('a bare string'));
    expect(html.posted).toHaveLength(before);
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('a JSON string message is parsed and routed', async () => {
    await boot();
    await send(JSON.stringify({ type: 'navigate', route: 'daily' }));
    expect(wixLocation.to).toHaveBeenCalledWith(APP_ROUTES.daily);
  });
});

describe('routing a message', () => {
  test('requestUserContext answers with the context', async () => {
    await boot();
    const before = html.postedOfType('userContext').length;
    await send({ type: 'requestUserContext' });
    expect(html.postedOfType('userContext')).toHaveLength(before + 1);
  });

  test('each navigate route goes to its own page', async () => {
    await boot();
    for (const [route, path] of [
      ['home', APP_ROUTES.home],
      ['daily', APP_ROUTES.daily],
      ['fleet', APP_ROUTES.fleet],
      ['bookings', APP_ROUTES.bookings],
      ['settings', APP_ROUTES.settings],
    ]) {
      wixLocation.to.mockClear();
      await send({ type: 'navigate', route });
      expect(wixLocation.to).toHaveBeenCalledWith(path);
    }
  });

  test('an unknown route navigates nowhere', async () => {
    await boot();
    await send({ type: 'navigate', route: 'elsewhere' });
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('a reload re-reads the board', async () => {
    await boot();
    const before = html.postedOfType('loadBookings').length;
    await send({ type: 'menuAction', action: 'reload' });
    expect(html.postedOfType('loadBookings')).toHaveLength(before + 1);
  });

  test('logout ends the session and returns to the home route', async () => {
    await boot();
    await send({ type: 'menuAction', action: 'logout' });

    expect(wixLocation.to).toHaveBeenCalledWith(APP_ROUTES.home);
    const [sessionRow] = fake.rows('StaffSessions');
    expect(sessionRow.active).toBe(false);
  });

  test('an unknown menu action does nothing', async () => {
    await boot();
    const before = html.posted.length;
    await send({ type: 'menuAction', action: 'selfDestruct' });
    expect(wixLocation.to).not.toHaveBeenCalled();
    expect(html.posted).toHaveLength(before);
  });

  test('all three reload-ish messages load the board', async () => {
    await boot();
    for (const type of ['bookingsReady', 'requestBookingsReload', 'requestBoardData']) {
      const before = html.postedOfType('loadBookings').length;
      await send({ type });
      expect(html.postedOfType('loadBookings')).toHaveLength(before + 1);
    }
  });

  test('a board request may carry its own date range', async () => {
    await boot();
    await send({ type: 'requestBoardData', startDate: '2026-03-01', endDate: '2026-03-31' });
    const last = html.postedOfType('loadBookings').pop();
    expect(last.filters).toEqual({ startDate: '2026-03-01', endDate: '2026-03-31' });
  });

  test('a malformed date in the request is ignored rather than applied', async () => {
    await boot();
    const before = html.postedOfType('loadBookings').pop().filters;
    await send({ type: 'requestBoardData', startDate: '01/03/2026' });
    expect(html.postedOfType('loadBookings').pop().filters).toEqual(before);
  });
});

describe('resizing the shell', () => {
  test('a sensible height is applied', async () => {
    await boot();
    await send({ type: 'resizeShell', height: 1200 });
    expect(html.height).toBe(1200);
  });

  test('a height below the floor is raised to it', async () => {
    await boot();
    await send({ type: 'resizeShell', height: 100 });
    expect(html.height).toBe(900);
  });

  test('a height above the ceiling is capped', async () => {
    await boot();
    await send({ type: 'resizeShell', height: 99999 });
    expect(html.height).toBe(5000);
  });

  test('a fractional height is rounded', async () => {
    await boot();
    await send({ type: 'resizeShell', height: 1200.6 });
    expect(html.height).toBe(1201);
  });

  test('a non-numeric or zero height is ignored, leaving the initial one', async () => {
    await boot();
    expect(html.height).toBe(1700);
    await send({ type: 'resizeShell', height: 'tall' });
    await send({ type: 'resizeShell', height: 0 });
    await send({ type: 'resizeShell', height: -50 });
    expect(html.height).toBe(1700);
  });
});

describe('opening a booking on another page', () => {
  test('openOnFleet carries the booking and the current range', async () => {
    await boot({ query: { startDate: '2026-03-01', endDate: '2026-03-31' } });
    await send({ type: 'openOnFleet', bookingId: 'bk-1' });

    const url = wixLocation.to.mock.calls.pop()[0];
    expect(url.startsWith(`${APP_ROUTES.fleet}?`)).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('bookingId')).toBe('bk-1');
    expect(params.get('from')).toBe('bookings');
    expect(params.get('startDate')).toBe('2026-03-01');
    expect(params.get('endDate')).toBe('2026-03-31');
  });

  test('openOnFleet without a booking still navigates', async () => {
    await boot();
    await send({ type: 'openOnFleet' });
    const url = wixLocation.to.mock.calls.pop()[0];
    expect(new URLSearchParams(url.split('?')[1]).has('bookingId')).toBe(false);
  });

  test('openContract needs a booking id, and refuses without one', async () => {
    await boot();
    await send({ type: 'openContract' });
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('openContract opens the contract in analysis mode', async () => {
    await boot();
    await send({ type: 'openContract', bookingId: 'bk-1' });

    const params = new URLSearchParams(wixLocation.to.mock.calls.pop()[0].split('?')[1]);
    expect(params.get('bookingId')).toBe('bk-1');
    expect(params.get('mode')).toBe('analysis');
    expect(params.get('from')).toBe('bookings');
  });

  test('openOnDaily defaults the view and tab', async () => {
    await boot({ query: { startDate: '2026-03-01', endDate: '2026-03-31' } });
    await send({ type: 'openOnDaily', bookingId: 'bk-1' });

    const params = new URLSearchParams(wixLocation.to.mock.calls.pop()[0].split('?')[1]);
    expect(params.get('view')).toBe('full');
    expect(params.get('tab')).toBe('bookings');
    expect(params.get('date')).toBe('2026-03-01');
  });

  test('openOnDaily honours an explicit date, view and tab', async () => {
    await boot();
    await send({ type: 'openOnDaily', bookingId: 'bk-1', date: '2026-04-02', viewMode: 'compact', tab: 'fleet' });

    const params = new URLSearchParams(wixLocation.to.mock.calls.pop()[0].split('?')[1]);
    expect(params.get('date')).toBe('2026-04-02');
    expect(params.get('view')).toBe('compact');
    expect(params.get('tab')).toBe('fleet');
  });

  test('openOnDaily falls back to the pickup date when no date is given', async () => {
    await boot();
    await send({ type: 'openOnDaily', bookingId: 'bk-1', pickupDate: '2026-04-09' });
    expect(new URLSearchParams(wixLocation.to.mock.calls.pop()[0].split('?')[1]).get('date')).toBe('2026-04-09');
  });
});

describe('changing a booking status', () => {
  test('applies the change and reports it back as a toast', async () => {
    await boot();
    await send({ type: 'setStatus', bookingId: 'bk-1', newStatus: 'Hold' });

    expect(fake.rows('BookingsNew')[0].status).toBe('Hold');
    expect(html.postedOfType('toast').pop().message).toBe('Booking hold');
  });

  test('a refused change is reported as an error, and nothing is written', async () => {
    await boot();
    await send({ type: 'setStatus', bookingId: 'bk-1', newStatus: 'Deleted' });

    expect(fake.rows('BookingsNew')[0].status).toBe('Pending');
    expect(html.postedOfType('toast').pop().message).toBe('Error: Invalid status');
  });

  test('the changed booking is focused once the board has reloaded', async () => {
    // The page defers this by 120ms so the embedded UI has painted the new rows
    // before being told which one to open.
    await boot();
    await send({ type: 'setStatus', bookingId: 'bk-1', newStatus: 'Hold' });

    expect(html.postedOfType('focusBooking')).toHaveLength(0);
    await flushDeferred();
    expect(html.postedOfType('focusBooking').pop()).toEqual({ type: 'focusBooking', bookingId: 'bk-1' });
  });

  test('the board is reloaded after a status change', async () => {
    await boot();
    const before = html.postedOfType('loadBookings').length;
    await send({ type: 'setStatus', bookingId: 'bk-1', newStatus: 'Hold' });
    expect(html.postedOfType('loadBookings').length).toBeGreaterThan(before);
  });

  test('the operator\'s own session token is what authorises it', async () => {
    // Not a token from the message. An embedded page cannot escalate by sending
    // one of its own.
    await boot();
    await send({ type: 'setStatus', bookingId: 'bk-1', newStatus: 'Hold', authToken: 'forged' });
    expect(fake.rows('BookingsNew')[0].status).toBe('Hold');
  });
});

describe('when the board fails to load', () => {
  test('an empty list and an error toast are posted rather than a blank page', async () => {
    await boot();
    const original = wixData.query;
    wixData.query = (collection) => {
      if (collection === 'BookingsNew') throw new Error('BookingsNew is offline');
      return original(collection);
    };
    try {
      await send({ type: 'menuAction', action: 'reload' });
      // getBookingsBoardData catches internally and answers success:false, so
      // the page posts the empty list it was given rather than an error toast.
      expect(html.postedOfType('loadBookings').pop().items).toEqual([]);
    } finally {
      wixData.query = original;
    }
  });
});
