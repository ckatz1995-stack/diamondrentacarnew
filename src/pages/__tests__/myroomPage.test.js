import { bootPageController, createComponent, staffSeed } from '../../../test/helpers/bootPageController.js';
import { derivePasswordHash, randomHex } from '../../backend/staffAccess.jsw';
import { APP_ROUTES } from '../../public/appRoutes.js';

// The backroom home shell. Everything an operator does from the dashboard menu
// arrives here as a postMessage from an embedded HtmlComponent, so this
// controller is both the navigation router and the session guard for the whole
// backroom.
//
// The property worth pinning hardest: the guard runs twice. Once on ready, and
// again on every single `navigate` message — so a session revoked while the
// shell sits open cannot be used to walk into another page.

const HOME = '#homeHtml';
const ALT_HOME = '#bpage1';
const STAFF = 'staff@example.com';
const PASSWORD = 'correct-horse-battery';
const TRUSTED = 'https://editor.wix.com';

const seed = () => staffSeed(derivePasswordHash, randomHex, { email: STAFF, password: PASSWORD });

let ctx;
let html;

async function boot({
  signedIn = true,
  extras = {},
  bare = false,
  query = {},
  url = 'https://diamond.example/myroom-home',
  path = ['myroom-home'],
} = {}) {
  html = createComponent(HOME);
  ctx = await bootPageController({
    importer: () => import('../Myroom.exiuw.js'),
    components: bare ? {} : { [HOME]: html, ...extras },
    seed: seed(),
    signInAs: signedIn ? STAFF : null,
    password: PASSWORD,
    query,
    url,
    path,
  });
  return ctx;
}

const send = (msg, origin = TRUSTED) => html.emitMessage({ origin, data: msg });
const lastAuthState = () => html.postedOfType('authState').pop();
const lastUserContext = () => html.postedOfType('userContext').pop();
const navigatedTo = () => ctx.wixLocation.to.mock.calls.map((c) => c[0]);
const storedToken = () => ctx.storage.local.getItem('diamond.backroom.session')
  || ctx.storage.session.getItem('diamond.backroom.session') || '';

let warn;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });

afterEach(async () => {
  if (ctx) await ctx.teardown();
  ctx = null;
  html = null;
  warn.mockRestore();
});

describe('opening the shell', () => {
  test('a signed-in operator gets the shell expanded and their context posted', async () => {
    await boot();

    expect(html.expanded).toBe(1);
    expect(html.shown).toBe(1);
    expect(navigatedTo()).toEqual([]);
    expect(lastAuthState()).toMatchObject({
      authenticated: true,
      user: 'A Operator',
      // Not 'Administrator', which is what the role row is labelled: an admin's
      // label is hard-coded, so renaming the role in the CMS changes nothing
      // an operator ever sees.
      role: 'Admin',
      email: STAFF,
    });
    expect(lastUserContext()).toMatchObject({ name: 'A Operator', company: 'DIAMOND Backroom' });
  });

  test('a signed-out visitor is sent to the login page carrying where they were headed', async () => {
    await boot({ signedIn: false, path: ['myroom-daily', 'shift'] });

    expect(navigatedTo()).toEqual([`${APP_ROUTES.login}?next=${encodeURIComponent('/myroom-daily/shift')}`]);
    // The guard fires before the message handler is wired, so the shell is inert.
    expect(html.postedMessages()).toEqual([]);
  });

  test('with no path to return to, the login link points back at the backroom home', async () => {
    await boot({ signedIn: false, path: [] });

    expect(navigatedTo()).toEqual([`${APP_ROUTES.login}?next=${encodeURIComponent(APP_ROUTES.home)}`]);
  });

  // getHomeComponent's own catch (and the `return null` after it) cannot be
  // reached: resolveHtmlComponent swallows every throw from $w internally and
  // returns null instead, so the try block always completes. Those two lines are
  // the file's only uncovered statements.
  test('a page with no HtmlComponent at all is left alone — including the guard', async () => {
    // Worth stating plainly: the session check sits *after* the component
    // lookup, so a page that is missing its shell is not redirected. Nothing is
    // rendered either, so there is nothing to protect.
    await boot({ signedIn: false, bare: true });

    expect(navigatedTo()).toEqual([]);
  });

  test('sibling HtmlComponents are collapsed, and both home ids are spared', async () => {
    const alt = createComponent(ALT_HOME);
    const stray = createComponent('#legacyHtml');
    await boot({ extras: { [ALT_HOME]: alt, '#legacyHtml': stray } });

    expect(stray.collapsed).toBe(1);
    expect(stray.hidden).toBe(1);
    expect(alt.collapsed).toBe(0);
    expect(html.collapsed).toBe(0);
  });

  test('a component that refuses to expand does not stop the shell from booting', async () => {
    html = createComponent(HOME, { expand() { throw new Error('locked'); } });
    ctx = await bootPageController({
      importer: () => import('../Myroom.exiuw.js'),
      components: { [HOME]: html },
      seed: seed(),
      signInAs: STAFF,
      password: PASSWORD,
      path: ['myroom-home'],
    });

    expect(lastAuthState()).toMatchObject({ authenticated: true });
    expect(warn).toHaveBeenCalledWith('[Myroom] expand/show failed', 'locked');
  });
});

describe('which messages are accepted', () => {
  beforeEach(async () => { await boot(); });

  test('a message from an untrusted origin is dropped', async () => {
    const before = html.posted.length;
    await send({ type: 'navigate', route: 'daily' }, 'https://evil.example');

    expect(navigatedTo()).toEqual([]);
    expect(html.posted.length).toBe(before);
  });

  test('an origin-less message is accepted, because Wix sometimes omits it', async () => {
    await send({ type: 'navigate', route: 'daily' }, '');

    expect(navigatedTo()).toEqual([APP_ROUTES.daily]);
  });

  // Mutation note: dropping the `origin &&` half of the guard changes nothing,
  // and no test can catch it. isTrustedBridgeOrigin already returns true for an
  // empty origin, so the two spellings agree on every input — the page repeats a
  // decision the bridge has already made.

  // Mutation note, likewise: narrowing the payload guard to `if (!msg) return;`
  // is undetectable. Every branch below re-tests `msg.type` against a literal,
  // so a non-object or a typeless object falls through to the same nothing.

  test('a trusted Wix suffix is accepted', async () => {
    await send({ type: 'navigate', route: 'fleet' }, 'https://diamond.wixsite.com');

    expect(navigatedTo()).toEqual([APP_ROUTES.fleet]);
  });

  test('the page’s own origin is accepted', async () => {
    await send({ type: 'navigate', route: 'bookings' }, 'https://diamond.example');

    expect(navigatedTo()).toEqual([APP_ROUTES.bookings]);
  });

  test('a JSON string payload is parsed', async () => {
    await send(JSON.stringify({ type: 'navigate', route: 'home' }));

    expect(navigatedTo()).toEqual([APP_ROUTES.home]);
  });

  test('an unparseable string, a null payload and a typeless object are all ignored', async () => {
    const before = html.posted.length;
    await send('not json at all');
    await send(null);
    await send({ route: 'daily' });
    await send('a plain string');

    expect(navigatedTo()).toEqual([]);
    expect(html.posted.length).toBe(before);
  });
});

describe('navigation', () => {
  beforeEach(async () => { await boot(); });

  test.each([
    ['home', APP_ROUTES.home],
    ['daily', APP_ROUTES.daily],
    ['fleet', APP_ROUTES.fleet],
    ['bookings', APP_ROUTES.bookings],
    ['pricing', APP_ROUTES.pricing],
    ['settings', APP_ROUTES.pricing],
  ])('route %s goes to %s', async (route, target) => {
    await send({ type: 'navigate', route });

    expect(navigatedTo()).toEqual([target]);
  });

  test('an unknown route goes nowhere', async () => {
    await send({ type: 'navigate', route: 'contract' });
    await send({ type: 'navigate' });

    expect(navigatedTo()).toEqual([]);
  });

  test('a session revoked while the shell is open cannot be used to navigate', async () => {
    // The whole reason navigate re-reads the session rather than trusting the
    // check that ran on ready: the shell can sit open for hours.
    const sessions = ctx.fake.rows('StaffSessions');
    expect(sessions).toHaveLength(1);
    await ctx.wixData.update('StaffSessions', { ...sessions[0], active: false }, { suppressAuth: true });

    await send({ type: 'navigate', route: 'daily' });

    expect(navigatedTo()).toEqual([`${APP_ROUTES.login}?next=${encodeURIComponent('/myroom-home')}`]);
  });

  test('a revoked session also loses the stored token, so a reload starts clean', async () => {
    const sessions = ctx.fake.rows('StaffSessions');
    await ctx.wixData.update('StaffSessions', { ...sessions[0], active: false }, { suppressAuth: true });
    await send({ type: 'navigate', route: 'daily' });

    expect(storedToken()).toBe('');
  });
});

describe('resizing the shell', () => {
  beforeEach(async () => { await boot(); });

  test('a height inside the range is applied, rounded', async () => {
    await send({ type: 'resizeShell', height: 1280.6 });

    expect(html.height).toBe(1281);
  });

  test('a height below the floor is raised to it', async () => {
    await send({ type: 'resizeShell', height: 120 });

    expect(html.height).toBe(720);
  });

  test('a height above the ceiling is capped', async () => {
    await send({ type: 'resizeShell', height: 99999 });

    expect(html.height).toBe(3200);
  });

  test('zero, negative and unparseable heights leave the shell alone', async () => {
    await send({ type: 'resizeShell', height: 0 });
    await send({ type: 'resizeShell', height: -50 });
    await send({ type: 'resizeShell', height: 'tall' });
    await send({ type: 'resizeShell' });

    expect(html.height).toBeUndefined();
  });

  test('an infinite height is refused rather than silently capped', async () => {
    // JSON.parse turns an overflowing numeric literal into Infinity, so this
    // arrives from the frame as a number. It is the only input that separates
    // the finiteness check from the `<= 0` one: NaN fails both, but Infinity
    // passes `<= 0` and would clamp to the ceiling as if it were a real request.
    // Written as a raw string on purpose: JSON.stringify would turn Infinity
    // back into null, but JSON.parse of an overflowing literal yields Infinity —
    // which is exactly how it reaches a real page.
    await send('{"type":"resizeShell","height":1e999}');

    expect(html.height).toBeUndefined();
  });

  test('a component that rejects the height logs and carries on', async () => {
    html = createComponent(HOME);
    Object.defineProperty(html, 'height', {
      set() { throw new Error('read only'); },
      get() { return undefined; },
    });
    ctx = await bootPageController({
      importer: () => import('../Myroom.exiuw.js'),
      components: { [HOME]: html },
      seed: seed(),
      signInAs: STAFF,
      password: PASSWORD,
      path: ['myroom-home'],
    });

    await send({ type: 'resizeShell', height: 1000 });

    expect(warn).toHaveBeenCalledWith('[Myroom] resizeShell height set failed', 'read only');
  });
});

describe('auth state broadcasts', () => {
  test.each(['homeReady', 'requestAuthState', 'requestUserContext'])('%s replies with both payloads', async (type) => {
    await boot();
    const before = html.postedOfType('authState').length;

    await send({ type });

    expect(html.postedOfType('authState').length).toBe(before + 1);
    expect(lastUserContext()).toMatchObject({ email: STAFF, role: 'Admin' });
  });

  test('the operator’s permissions travel with the state', async () => {
    await boot();

    expect(lastAuthState().permissions).toEqual(expect.objectContaining({ pricingView: true }));
  });

  test('a denied=1 query is reported as a denial, and the next path is passed through', async () => {
    await boot({ query: { denied: '1', next: '  /myroom-fleetchart  ' } });

    expect(lastAuthState()).toMatchObject({ denied: true, nextPath: '/myroom-fleetchart' });
  });

  test('any other denied value is not a denial', async () => {
    await boot({ query: { denied: 'true' } });

    expect(lastAuthState()).toMatchObject({ denied: false, nextPath: '' });
  });

  test('the auth health probe is reported when it answers', async () => {
    await boot();

    expect(lastAuthState().authHealth).toMatchObject({ ok: true });
  });

  test('a failing auth health probe degrades to null rather than breaking the page', async () => {
    await boot();
    const staffAccess = await import('../../backend/staffAccess.jsw');
    const original = staffAccess.getPublicAuthHealth;
    staffAccess.getPublicAuthHealth = () => Promise.reject(new Error('diagnostics down'));
    try {
      await send({ type: 'requestAuthState' });
    } finally {
      staffAccess.getPublicAuthHealth = original;
    }

    expect(lastAuthState()).toMatchObject({ authenticated: true, authHealth: null });
  });
});

describe('the shell menu', () => {
  beforeEach(async () => { await boot(); });

  test('reload returns to the backroom home', async () => {
    await send({ type: 'menuAction', action: 'reload' });

    expect(navigatedTo()).toEqual([APP_ROUTES.home]);
  });

  test('logout ends the server session, drops the token and reports the sign-out', async () => {
    await send({ type: 'menuAction', action: 'logout' });

    expect(storedToken()).toBe('');
    expect(ctx.fake.rows('StaffSessions').every((s) => s.active === false)).toBe(true);
    // Mutation note: the page's own clearSessionToken() call is dead weight —
    // logoutBackroom() clears the token before it returns, so deleting the page's
    // call leaves this assertion green. Kept as belt and braces, recorded here so
    // the redundancy is not mistaken for a coverage gap.
    expect(lastAuthState()).toMatchObject({
      authenticated: false,
      user: 'Operator',
      role: 'Backroom',
      errorMessage: 'Έγινε αποσύνδεση από το backroom.',
    });
    // Signing out does not navigate. The shell stays put and re-renders signed out.
    expect(navigatedTo()).toEqual([]);
  });

  test('an unknown menu action does nothing', async () => {
    const before = html.posted.length;
    await send({ type: 'menuAction', action: 'explode' });
    await send({ type: 'menuAction' });

    expect(navigatedTo()).toEqual([]);
    expect(html.posted.length).toBe(before);
  });
});
