import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { installPageEnv, createComponent } from '../../../test/helpers/fakePageEnv.js';
import { APP_ROUTES } from '../../public/appRoutes.js';

// The login page. Credentials are typed into an embedded HtmlComponent and
// arrive here as a postMessage, so this controller is the seam between an
// untrusted frame and the staff authentication endpoint.
//
// Everything is imported dynamically inside boot(), after jest.resetModules(),
// so the controller and this test share one module registry — see
// bookingBoardPage.test.js for what happens otherwise.

const HTML_ID = '#loginHtml';
const STAFF = 'staff@example.com';
const PASSWORD = 'correct-horse-battery';
const TRUSTED = 'https://editor.wix.com';

function seed(hash, hex, extra = {}) {
  const passwordSalt = hex(16);
  return {
    StaffRoles: [{ _id: 'role-admin', key: 'admin', label: 'Administrator', active: true }],
    StaffUsers: [{ _id: 'u-1', email: STAFF, fullName: 'A Operator', roleKey: 'admin', active: true }],
    StaffCredentials: [{
      _id: 'cred-1', email: STAFF, passwordSalt,
      passwordHash: hash(PASSWORD, passwordSalt), active: true,
    }],
    StaffSessions: [],
    StaffAuditLog: [],
    ...extra,
  };
}

let fake;
let env;
let html;
let wixLocation;
let wixData;
let storage;

async function boot({ query = {}, url = 'https://diamond.example/home-login', componentId = HTML_ID } = {}) {
  jest.resetModules();
  jest.useFakeTimers({ now: new Date('2026-03-10T12:00:00.000Z') });

  wixLocation = (await import('wix-location')).default;
  wixData = (await import('wix-data')).default;
  storage = await import('wix-storage');
  const { derivePasswordHash, randomHex } = await import('../../backend/staffAccess.jsw');

  storage.local.clear();
  storage.session.clear();

  fake = createFakeWixData(seed(derivePasswordHash, randomHex)).install(wixData);
  wixLocation.query = query;
  wixLocation.url = url;
  wixLocation.path = ['home-login'];
  wixLocation.to = jest.fn();

  html = createComponent(componentId);
  env = installPageEnv({ [componentId]: html });
  await env.start(() => import('../Home Login.gxie4.js'));
  return html;
}

const send = (msg, origin = TRUSTED) => html.emitMessage({ origin, data: msg });
const lastAuthState = () => html.postedOfType('authState').pop();
const storedToken = () => storage.local.getItem('diamond.backroom.session')
  || storage.session.getItem('diamond.backroom.session') || '';

afterEach(() => {
  if (env) {
    jest.runOnlyPendingTimers();
    env.restore();
  }
  env = null;
  if (fake) fake.restore();
  fake = null;
  jest.useRealTimers();
});

describe('opening the page', () => {
  test('shows the login component and reports a signed-out state', async () => {
    await boot();
    expect(html.expanded).toBe(1);
    expect(html.shown).toBe(1);
    expect(lastAuthState()).toMatchObject({ authenticated: false, user: 'Operator', role: 'Backroom' });
  });

  test('the component is found under any of its candidate ids', async () => {
    // The page has six candidate selectors because the editor has renamed the
    // component over time; any of them has to work.
    for (const id of ['#loginHtml', '#homeHtml', '#bpage1', '#html1', '#html2', '#customElement1']) {
      await boot({ componentId: id });
      expect(html.shown).toBe(1);
      env.restore();
      env = null;
      fake.restore();
      fake = null;
    }
  });

  test('the candidate list decides which component is used, not page order', async () => {
    // With a decoy HtmlComponent sitting ahead of the real one, the type-based
    // fallback inside resolveHtmlComponent would pick the decoy. Only the
    // named candidate list gets this right — and with a single component on the
    // page the two are indistinguishable.
    jest.resetModules();
    jest.useFakeTimers({ now: new Date('2026-03-10T12:00:00.000Z') });
    wixLocation = (await import('wix-location')).default;
    wixData = (await import('wix-data')).default;
    storage = await import('wix-storage');
    const { derivePasswordHash, randomHex } = await import('../../backend/staffAccess.jsw');
    storage.local.clear();
    storage.session.clear();
    fake = createFakeWixData(seed(derivePasswordHash, randomHex)).install(wixData);
    wixLocation.query = {};
    wixLocation.url = 'https://diamond.example/home-login';
    wixLocation.to = jest.fn();

    const decoy = createComponent('#decoyHtml');
    html = createComponent(HTML_ID);
    env = installPageEnv({ '#decoyHtml': decoy, [HTML_ID]: html });
    await env.start(() => import('../Home Login.gxie4.js'));

    expect(html.shown).toBe(1);
    expect(decoy.shown).toBe(0);
    expect(html.postedOfType('authState').length).toBeGreaterThan(0);
    expect(decoy.posted).toHaveLength(0);
  });

  test('a page with no login component at all does nothing rather than throwing', async () => {
    jest.resetModules();
    jest.useFakeTimers({ now: new Date('2026-03-10T12:00:00.000Z') });
    wixLocation = (await import('wix-location')).default;
    wixData = (await import('wix-data')).default;
    const { derivePasswordHash, randomHex } = await import('../../backend/staffAccess.jsw');
    fake = createFakeWixData(seed(derivePasswordHash, randomHex)).install(wixData);
    wixLocation.query = {};
    wixLocation.to = jest.fn();

    env = installPageEnv({});
    await expect(env.start(() => import('../Home Login.gxie4.js'))).resolves.toBeUndefined();
  });

  test('a denied redirect is passed on to the panel', async () => {
    await boot({ query: { denied: '1' } });
    expect(lastAuthState().denied).toBe(true);
  });

  test('anything other than exactly "1" is not denied', async () => {
    await boot({ query: { denied: 'true' } });
    expect(lastAuthState().denied).toBe(false);
  });

  test('the next path is handed to the panel so it can say where you were going', async () => {
    await boot({ query: { next: '/myroom-bookingboard' } });
    expect(lastAuthState().nextPath).toBe('/myroom-bookingboard');
  });

  test('the bootstrap and health probes are included, and neither leaks diagnostics', async () => {
    await boot();
    const state = lastAuthState();
    expect(state.bootstrap).toMatchObject({ ready: true, bootstrapAvailable: false, bootstrapMode: 'private' });
    expect(state.authHealth).toMatchObject({ ok: true, bootstrapAvailable: false });
  });

  test('a failing probe leaves a null rather than breaking the page', async () => {
    await boot();
    const before = html.postedOfType('authState').length;
    const original = wixData.query;
    wixData.query = () => { throw new Error('backend unreachable'); };
    try {
      await send({ type: 'requestAuthState' });
      expect(html.postedOfType('authState').length).toBeGreaterThan(before);
    } finally {
      wixData.query = original;
    }
  });

  test('the user context is posted alongside the auth state', async () => {
    await boot();
    expect(html.postedOfType('userContext')).toHaveLength(1);
  });
});

describe('the origin check on the login seam', () => {
  test('a message from an untrusted origin is ignored', async () => {
    await boot();
    const before = html.posted.length;
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD }, 'https://evil.example');

    expect(html.posted).toHaveLength(before);
    expect(storedToken()).toBe('');
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('a near-miss host is untrusted too', async () => {
    await boot();
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD }, 'https://notwix.com');
    expect(storedToken()).toBe('');
  });

  test('an empty origin is accepted, which is how this page is written', async () => {
    // Deliberately different from the Booking Board's `if (!isTrusted) return`:
    // here it is `if (origin && !trusted) return`, so a message with no origin
    // metadata short-circuits the check entirely rather than passing it. Same
    // net effect today, because isTrustedBridgeOrigin also accepts an empty
    // origin — but this page would keep accepting them even if that changed.
    await boot();
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD }, '');
    expect(storedToken()).not.toBe('');
  });

  test('a message from the page\'s own host is trusted, even on a custom domain', async () => {
    // This is what the second argument to isTrustedBridgeOrigin buys: a site on
    // its own domain still has to talk to itself. Without a test on a host that
    // is not in the shipped allowlist, dropping that argument changes nothing.
    await boot({ url: 'https://diamond.example/home-login' });
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD }, 'https://diamond.example');
    expect(storedToken()).not.toBe('');
  });

  test('but another host on that domain is not', async () => {
    await boot({ url: 'https://diamond.example/home-login' });
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD }, 'https://other.example');
    expect(storedToken()).toBe('');
  });

  test('a login sent as a JSON string is parsed and honoured', async () => {
    // HtmlComponent delivers a string when the payload could not be cloned, so
    // the normalise step is load-bearing rather than defensive.
    await boot();
    await send(JSON.stringify({ type: 'staffLogin', email: STAFF, password: PASSWORD }));
    expect(storedToken()).not.toBe('');
  });

  test('a whitespace-only origin is treated as absent', async () => {
    await boot();
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD }, '   ');
    expect(storedToken()).not.toBe('');
  });

  test('a message with no type is ignored', async () => {
    await boot();
    const before = html.posted.length;
    await send({ noType: true });
    await send(null);
    expect(html.posted).toHaveLength(before);
  });
});

describe('signing in', () => {
  test('a correct password issues a session and stores it', async () => {
    await boot();
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD });

    expect(storedToken()).not.toBe('');
    expect(fake.rows('StaffSessions')).toHaveLength(1);
  });

  test('and the panel is told the operator is now signed in', async () => {
    await boot();
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD });
    expect(lastAuthState()).toMatchObject({ authenticated: true, email: STAFF, user: 'A Operator' });
  });

  test('remember-me keeps the token out of the per-tab store', async () => {
    await boot();
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD, remember: true });
    expect(storage.local.getItem('diamond.backroom.session')).not.toBeNull();
    expect(storage.session.getItem('diamond.backroom.session')).toBeNull();
  });

  test('without remember-me the token is in both stores', async () => {
    await boot();
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD });
    expect(storage.local.getItem('diamond.backroom.session')).not.toBeNull();
    expect(storage.session.getItem('diamond.backroom.session')).not.toBeNull();
  });

  test('a padded email still signs in', async () => {
    // Trimmed twice over — loginStaff normalises the address itself, so the
    // page's own trim cannot change the outcome. The behaviour is what matters.
    await boot();
    await send({ type: 'staffLogin', email: `  ${STAFF}  `, password: PASSWORD });
    expect(storedToken()).not.toBe('');
  });

  test('the password is NOT trimmed, so leading spaces are part of it', async () => {
    await boot();
    await send({ type: 'staffLogin', email: STAFF, password: ` ${PASSWORD}` });
    expect(storedToken()).toBe('');
  });

  test('a wrong password stores nothing and reports the failure', async () => {
    await boot();
    await send({ type: 'staffLogin', email: STAFF, password: 'wrong' });

    expect(storedToken()).toBe('');
    expect(fake.rows('StaffSessions')).toHaveLength(0);
    expect(lastAuthState()).toMatchObject({ authenticated: false });
    expect(lastAuthState().errorMessage).toBeTruthy();
  });

  test('an unknown account is refused the same way as a wrong password', async () => {
    // The two must be indistinguishable from the panel, or the page becomes an
    // account-enumeration oracle.
    await boot();
    await send({ type: 'staffLogin', email: 'nobody@example.com', password: PASSWORD });
    const unknown = lastAuthState().errorMessage;

    await boot();
    await send({ type: 'staffLogin', email: STAFF, password: 'wrong' });
    const wrongPassword = lastAuthState().errorMessage;

    expect(unknown).toBe(wrongPassword);
  });

  test('a failed sign-in does not navigate away', async () => {
    await boot();
    await send({ type: 'staffLogin', email: STAFF, password: 'wrong' });
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('a missing password is refused', async () => {
    await boot();
    await send({ type: 'staffLogin', email: STAFF });
    expect(storedToken()).toBe('');
  });
});

describe('where you land after signing in', () => {
  test('the home route when nothing else was asked for', async () => {
    await boot();
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD });
    expect(wixLocation.to).toHaveBeenCalledWith(APP_ROUTES.home);
  });

  test('the page you were sent away from', async () => {
    await boot({ query: { next: '/myroom-bookingboard' } });
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD });
    expect(wixLocation.to).toHaveBeenCalledWith('/myroom-bookingboard');
  });

  test('an absolute URL in `next` is refused, landing home instead', async () => {
    // This used to be an open redirect: `next` went to wixLocation.to unchecked,
    // so a /home-login?next=https://evil.example/... link put the operator on
    // another origin immediately after a *successful* sign-in — convincing
    // precisely because the sign-in really did work.
    await boot({ query: { next: 'https://evil.example/looks-like-the-backroom' } });
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD });
    expect(wixLocation.to).toHaveBeenCalledWith(APP_ROUTES.home);
  });

  test('a protocol-relative URL is refused too', async () => {
    // '//evil.example/x' has no scheme but still leaves the site, which is why
    // "starts with a slash" is not on its own a sufficient test.
    await boot({ query: { next: '//evil.example/x' } });
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD });
    expect(wixLocation.to).toHaveBeenCalledWith(APP_ROUTES.home);
  });

  test('a scheme-relative or javascript URL is refused', async () => {
    for (const next of ['javascript:alert(1)', 'http://evil.example', 'data:text/html,x', 'myroom-home']) {
      await boot({ query: { next } });
      await send({ type: 'staffLogin', email: STAFF, password: PASSWORD });
      expect(wixLocation.to).toHaveBeenCalledWith(APP_ROUTES.home);
      env.restore(); env = null; fake.restore(); fake = null;
    }
  });

  test('a deep link with its own query string still works', async () => {
    // requireBackroomAccess produces these for the contract and fleet pages, so
    // the guard has to be shape-based rather than an allowlist of bare routes.
    await boot({ query: { next: '/myroom-contract?bookingId=bk-1&mode=analysis' } });
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD });
    expect(wixLocation.to).toHaveBeenCalledWith('/myroom-contract?bookingId=bk-1&mode=analysis');
  });

  test('a padded same-site path is trimmed and followed', async () => {
    await boot({ query: { next: '  /myroom-daily  ' } });
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD });
    expect(wixLocation.to).toHaveBeenCalledWith('/myroom-daily');
  });

  test('a whitespace-only next falls back to the home route', async () => {
    await boot({ query: { next: '   ' } });
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD });
    expect(wixLocation.to).toHaveBeenCalledWith(APP_ROUTES.home);
  });
});

describe('requesting access recovery', () => {
  test('is accepted and reported back', async () => {
    await boot();
    await send({ type: 'requestAccessRecovery', email: STAFF });
    expect(lastAuthState().errorMessage).toContain('recovery');
  });

  test('an unknown address gets the same answer, so it cannot be used to probe', async () => {
    await boot();
    await send({ type: 'requestAccessRecovery', email: STAFF });
    const known = lastAuthState().errorMessage;

    await boot();
    await send({ type: 'requestAccessRecovery', email: 'nobody@example.com' });
    expect(lastAuthState().errorMessage).toBe(known);
  });

  test('recovery does not sign anyone in', async () => {
    await boot();
    await send({ type: 'requestAccessRecovery', email: STAFF });
    expect(storedToken()).toBe('');
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('a stored token that resolves to no session is cleared on the next refresh', async () => {
    // Worth stating on its own: any refresh re-reads the session, and a token
    // the server does not recognise is dropped rather than re-sent forever.
    // It also means a token planted in storage cannot survive a single refresh,
    // which is why several ways of planting one are unobservable from outside.
    await boot();
    const { storeSessionToken } = await import('../../public/backroomAuth.js');
    storeSessionToken('not-a-real-token', true);
    expect(storedToken()).toBe('not-a-real-token');

    await send({ type: 'requestAuthState' });

    expect(storedToken()).toBe('');
    expect(lastAuthState().authenticated).toBe(false);
  });
});

describe('refreshing and resizing', () => {
  test('all three refresh messages re-post the auth state', async () => {
    await boot();
    for (const type of ['loginReady', 'requestAuthState', 'requestLoginBootstrap']) {
      const before = html.postedOfType('authState').length;
      await send({ type });
      expect(html.postedOfType('authState').length).toBe(before + 1);
    }
  });

  test('an already-signed-in visitor is reported as such', async () => {
    await boot();
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD });
    await send({ type: 'requestAuthState' });
    expect(lastAuthState()).toMatchObject({ authenticated: true, email: STAFF });
  });

  test('the permissions map is handed over for the panel to render from', async () => {
    await boot();
    await send({ type: 'staffLogin', email: STAFF, password: PASSWORD });
    expect(lastAuthState().permissions.__admin).toBe(true);
  });

  test('a sensible height is applied', async () => {
    await boot();
    await send({ type: 'resizeShell', height: 1000 });
    expect(html.height).toBe(1000);
  });

  test('the height is clamped to this page\'s own range', async () => {
    // 640 to 2400 here, against the board's 900 to 5000.
    await boot();
    await send({ type: 'resizeShell', height: 10 });
    expect(html.height).toBe(640);
    await send({ type: 'resizeShell', height: 99999 });
    expect(html.height).toBe(2400);
  });

  test('a nonsensical height is ignored rather than applied', async () => {
    await boot();
    await send({ type: 'resizeShell', height: 'tall' });
    await send({ type: 'resizeShell', height: 0 });
    expect(html.height).toBeUndefined();
  });

  test('an unknown message type does nothing', async () => {
    await boot();
    const before = html.posted.length;
    await send({ type: 'somethingElse' });
    expect(html.posted).toHaveLength(before);
  });
});
