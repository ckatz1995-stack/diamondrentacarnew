import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { installPageEnv, createComponent } from '../../../test/helpers/fakePageEnv.js';
import { APP_ROUTES } from '../../public/appRoutes.js';

// The account settings page: the pricing catalogue and the staff directory,
// both edited from one embedded panel. Its message router dispatches 28 action
// types, several of which set staff passwords or revoke sessions.
//
// The page itself is gated at pricing/View. That is deliberately weaker than
// what several of its actions do, so the property worth pinning is that the
// backend guards hold the line independently — a pricing operator can open the
// screen and still be refused every staff-administration action on it.

const COMP = '#pricingAdminHtml';
const ADMIN = 'admin@example.com';
const PRICER = 'pricer@example.com';
const OUTSIDER = 'rentals@example.com';
const PASSWORD = 'correct-horse-battery';
const TRUSTED = 'https://editor.wix.com';

function seed(hash, hex) {
  const salt = hex(16);
  const cred = (email) => ({
    _id: `cred-${email}`, email, passwordSalt: salt,
    passwordHash: hash(PASSWORD, salt), active: true,
  });
  return {
    StaffRoles: [
      { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true },
      // May look at pricing. Cannot manage staff, and cannot edit pricing either.
      {
        _id: 'role-pricer', key: 'pricer', label: 'Pricing viewer', active: true,
        pricingView: true, specialPermissions: '',
      },
      // Signed in, but with no pricing permission at all — the only role that
      // can tell the guard's `area: 'pricing'` from a bare signed-in check.
      {
        _id: 'role-rentals', key: 'rentals', label: 'Rentals only', active: true,
        rentalsView: true, specialPermissions: '',
      },
    ],
    StaffUsers: [
      { _id: 'u-1', email: ADMIN, fullName: 'A Admin', roleKey: 'admin', active: true },
      { _id: 'u-2', email: PRICER, fullName: 'A Pricer', roleKey: 'pricer', active: true },
      { _id: 'u-3', email: OUTSIDER, fullName: 'An Outsider', roleKey: 'rentals', active: true },
    ],
    StaffCredentials: [cred(ADMIN), cred(PRICER), cred(OUTSIDER)],
    StaffSessions: [],
    StaffAuditLog: [],
    PricingAuditLog: [],
    BusinessSettings: [{ _id: 'bs-1', currency: 'EUR' }],
    InsurancePlans: [{ _id: 'i-1', key: 'cdw', label: 'CDW', pricePerDay: 10 }],
    ExtraServices: [{ _id: 'x-1', key: 'gps', label: 'GPS', price: 5 }],
    FeeRules: [{ _id: 'f-1', key: 'night', label: 'Night', amount: 15 }],
    PricingSeasons: [],
    CategoryRateRules: [],
    PickupLocations: [],
    VehiclesNew: [],
    FleetNew: [],
  };
}

let fake;
let env;
let html;
let wixLocation;
let wixData;

async function boot({ email = ADMIN } = {}) {
  jest.resetModules();
  jest.useFakeTimers({ now: new Date('2026-03-10T12:00:00.000Z') });

  wixLocation = (await import('wix-location')).default;
  wixData = (await import('wix-data')).default;
  const storage = await import('wix-storage');
  const { loginStaff, derivePasswordHash, randomHex } = await import('../../backend/staffAccess.jsw');
  const { storeSessionToken } = await import('../../public/backroomAuth.js');
  const { clearPricingCatalogCache } = await import('../../backend/pricingCatalog.jsw');

  storage.local.clear();
  storage.session.clear();
  clearPricingCatalogCache();

  fake = createFakeWixData(seed(derivePasswordHash, randomHex)).install(wixData);
  if (email) {
    const { sessionToken } = await loginStaff({ email, password: PASSWORD });
    storeSessionToken(sessionToken, true);
  }
  wixLocation.query = {};
  wixLocation.url = 'https://diamond.example/account-settings';
  wixLocation.path = ['account-settings'];
  wixLocation.to = jest.fn();

  html = createComponent(COMP);
  env = installPageEnv({ [COMP]: html });
  await env.start(() => import('../Account Settings.ehaf1.js'));
  return html;
}

const send = (msg, origin = TRUSTED) => html.emitMessage({ origin, data: msg });
const act = (type, payload = {}) => send({ type, payload });
const toasts = () => html.postedOfType('toast');
const lastToast = () => toasts().pop();
const lastSnapshot = () => html.postedOfType('adminSnapshot').pop();

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
  test('a signed-out visitor is redirected and the panel is never bound', async () => {
    await boot({ email: null });
    expect(wixLocation.to).toHaveBeenCalled();
    expect(html.posted).toHaveLength(0);
    // Nothing is listening, so a message cannot reach the dispatcher either.
    await send({ type: 'pricingAdminReady' });
    expect(html.posted).toHaveLength(0);
  });

  test('a signed-in operator with no pricing permission is refused the screen', async () => {
    // The guard names an area, so being signed in is not enough. Without a role
    // that lacks pricing entirely, dropping the area argument would change
    // nothing observable.
    await boot({ email: OUTSIDER });
    expect(wixLocation.to.mock.calls[0][0]).toContain('denied=1');
    expect(html.posted).toHaveLength(0);

    await send({ type: 'pricingAdminReady' });
    expect(html.posted).toHaveLength(0);
  });

  test('an operator who may view pricing gets in', async () => {
    await boot({ email: PRICER });
    await send({ type: 'pricingAdminReady' });
    expect(lastSnapshot()).toBeTruthy();
  });

  test('the snapshot carries both the pricing catalogue and the staff directory', async () => {
    await boot();
    await send({ type: 'pricingAdminReady' });
    const snap = lastSnapshot();
    expect(snap.snapshot.insurancePlans.length).toBeGreaterThan(0);
    expect(snap.accessSnapshot).toBeTruthy();
    expect(snap.meta.user).toBe(ADMIN);
  });

  test('the busy flag is cleared once the snapshot has been sent', async () => {
    await boot();
    await act('refreshStaffAccess');
    expect(html.postedOfType('busy').pop()).toEqual({ type: 'busy', flag: false });
  });
});

describe('the origin check', () => {
  test('an untrusted origin reaches nothing', async () => {
    await boot();
    const before = html.posted.length;
    await send({ type: 'pricingAdminReady' }, 'https://evil.example');
    expect(html.posted).toHaveLength(before);
  });

  test('a near-miss host is untrusted too', async () => {
    await boot();
    const before = html.posted.length;
    await send({ type: 'pricingAdminReady' }, 'https://notwix.com');
    expect(html.posted).toHaveLength(before);
  });

  test('an empty origin is accepted, as on the login page', async () => {
    await boot();
    await send({ type: 'pricingAdminReady' }, '');
    expect(lastSnapshot()).toBeTruthy();
  });

  test('a message from the page\'s own host is trusted, even on a custom domain', async () => {
    // What passing wixLocation.url to the check buys. diamond.example is not in
    // the shipped allowlist, so only the same-host rule can accept it.
    await boot();
    await send({ type: 'pricingAdminReady' }, 'https://diamond.example');
    expect(lastSnapshot()).toBeTruthy();
  });

  test('but another host is not, custom domain or otherwise', async () => {
    await boot();
    const before = html.posted.length;
    await send({ type: 'pricingAdminReady' }, 'https://other.example');
    expect(html.posted).toHaveLength(before);
  });

  test('a JSON string message is parsed', async () => {
    await boot();
    await send(JSON.stringify({ type: 'pricingAdminReady' }));
    expect(lastSnapshot()).toBeTruthy();
  });

  test('unparseable JSON is ignored', async () => {
    await boot();
    const before = html.posted.length;
    await send('{not json');
    expect(html.posted).toHaveLength(before);
  });

  test('a message with no type is ignored', async () => {
    // Guarded twice: the dispatch list below would reject an undefined type
    // anyway, so the explicit check cannot change the outcome on its own.
    await boot();
    const before = html.posted.length;
    await send({ payload: {} });
    expect(html.posted).toHaveLength(before);
  });

  test('a message type outside the dispatch list is ignored', async () => {
    // The router only acts on 28 named types; anything else falls through
    // without reaching handleAction at all.
    await boot();
    const before = html.posted.length;
    await send({ type: 'deleteEverything', payload: {} });
    expect(html.posted).toHaveLength(before);
  });
});

describe('the page guard is weaker than what the page can do', () => {
  // Gated at pricing/View, yet it dispatches staff administration. The backend
  // guards are what actually hold the line, and these prove they do.
  const STAFF_ACTIONS = [
    ['setStaffPassword', { email: ADMIN, newPassword: 'newpassword123' }],
    ['resetStaffPassword', { email: ADMIN }],
    ['revokeStaffSessions', { email: ADMIN }],
    ['deactivateStaffUser', { itemId: 'u-1' }],
    ['upsertStaffRole', { key: 'newrole', label: 'New role' }],
  ];

  test.each(STAFF_ACTIONS)('a pricing viewer is refused %s', async (type, payload) => {
    await boot({ email: PRICER });
    await act(type, payload);
    expect(lastToast()).toMatchObject({ tone: 'error' });
  });

  test('a refused password change leaves the credential untouched', async () => {
    await boot({ email: PRICER });
    const before = fake.rows('StaffCredentials').find((c) => c.email === ADMIN).passwordHash;

    await act('setStaffPassword', { email: ADMIN, newPassword: 'newpassword123' });

    expect(fake.rows('StaffCredentials').find((c) => c.email === ADMIN).passwordHash).toBe(before);
    expect(html.postedOfType('staffPasswordResult')).toHaveLength(0);
  });

  test('a refused session revocation leaves the sessions alive', async () => {
    await boot({ email: PRICER });
    const active = fake.rows('StaffSessions').filter((s) => s.active !== false).length;

    await act('revokeStaffSessions', { email: ADMIN });

    expect(fake.rows('StaffSessions').filter((s) => s.active !== false)).toHaveLength(active);
  });

  test('a pricing viewer cannot edit pricing either, despite reaching the screen', async () => {
    await boot({ email: PRICER });
    await act('upsertInsurancePlan', { key: 'cdw', label: 'CDW', pricePerDay: 0 });

    expect(lastToast()).toMatchObject({ tone: 'error' });
    expect(fake.rows('InsurancePlans').find((p) => p.key === 'cdw').pricePerDay).toBe(10);
  });

  test('an admin is allowed the same actions', async () => {
    await boot();
    await act('setStaffPassword', { email: PRICER, newPassword: 'newpassword123' });

    expect(html.postedOfType('staffPasswordResult').pop().result).toMatchObject({ mode: 'set', success: true, email: PRICER });
    expect(lastToast()).toMatchObject({ tone: 'success' });
  });

  test('the operator\'s own session is what authorises an action, not the message', async () => {
    await boot({ email: PRICER });
    await send({ type: 'setStaffPassword', payload: { email: ADMIN, newPassword: 'x1234567' }, authToken: 'forged', sessionToken: 'forged' });
    expect(lastToast()).toMatchObject({ tone: 'error' });
  });
});

describe('pricing actions an admin may take', () => {
  test('saving a plan writes it and reports success', async () => {
    await boot();
    await act('upsertInsurancePlan', { key: 'cdw', label: 'CDW', pricePerDay: 42 });

    expect(fake.rows('InsurancePlans').find((p) => p.key === 'cdw').pricePerDay).toBe(42);
    expect(lastToast()).toMatchObject({ tone: 'success' });
  });

  test('a delete passes its own fields through rather than nesting them', async () => {
    // The delete actions spread the payload, where the upserts pass it as
    // `payload`. Sending a delete the wrong shape would silently target nothing.
    await boot();
    await act('upsertInsurancePlan', { key: 'housecover', label: 'House cover', pricePerDay: 12 });
    const id = fake.rows('InsurancePlans').find((p) => p.key === 'housecover')._id;

    await act('deletePricingItem', { collectionName: 'InsurancePlans', itemId: id });

    expect(fake.rows('InsurancePlans').map((p) => p.key)).not.toContain('housecover');
    expect(lastToast()).toMatchObject({ tone: 'success' });
  });

  test('deleting the last row and refreshing restores the shipped catalogue', async () => {
    // The documented edge of the delete fix, shown end to end: emptying a
    // collection means "not configured", and the very next snapshot the page
    // asks for runs ensurePricingSeeded and writes the shipped rows back. So
    // deleting the only plan reads as a reset on screen, not a removal.
    await boot();
    await act('deletePricingItem', { collectionName: 'InsurancePlans', itemId: 'i-1' });

    const keys = fake.rows('InsurancePlans').map((p) => p.key);
    expect(keys).not.toHaveLength(0);
    expect(keys).toContain('cdw');
    expect(fake.rows('InsurancePlans').find((p) => p.key === 'cdw').pricePerDay).toBe(0);
  });

  test('a refused delete is reported as an error and removes nothing', async () => {
    await boot();
    const before = fake.rows('StaffCredentials').map((c) => c._id).sort();
    await act('deletePricingItem', { collectionName: 'StaffCredentials', itemId: before[0] });

    expect(fake.rows('StaffCredentials').map((c) => c._id).sort()).toEqual(before);
    expect(lastToast()).toMatchObject({ tone: 'error' });
  });

  test('every save is followed by a fresh snapshot', async () => {
    await boot();
    const before = html.postedOfType('adminSnapshot').length;
    await act('upsertExtraService', { key: 'gps', label: 'GPS', price: 9 });
    expect(html.postedOfType('adminSnapshot').length).toBe(before + 1);
  });

  test('seeding defaults reports its own result alongside the snapshot', async () => {
    await boot();
    await act('seedPricingDefaults', { target: 'insurance' });
    expect(html.postedOfType('seedPricingResult')).toHaveLength(1);
    expect(lastToast().message).toContain('insurance plans');
  });

  test('an unrecognised seed target still names something in the toast', async () => {
    await boot();
    await act('seedPricingDefaults', { target: 'nonsense' });
    expect(lastToast().message).toContain('τον κατάλογο');
  });

  test('resetting defaults reports its own result too', async () => {
    await boot();
    await act('resetPricingDefaults', { target: 'all' });
    expect(html.postedOfType('resetPricingResult')).toHaveLength(1);
    expect(lastToast().message).toContain('όλος ο κατάλογος');
  });
});

describe('navigation from the panel', () => {
  test('a known route is followed', async () => {
    await boot();
    await send({ type: 'navigate', route: 'daily' });
    expect(wixLocation.to).toHaveBeenCalledWith(APP_ROUTES.daily);
  });

  test('an unknown route goes nowhere', async () => {
    await boot();
    await send({ type: 'navigate', route: 'elsewhere' });
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('an empty route goes nowhere either', async () => {
    // The `route &&` in front is belt-and-braces: '' is not an own property of
    // the route map, so the hasOwnProperty check rejects it regardless.
    await boot();
    await send({ type: 'navigate', route: '' });
    await send({ type: 'navigate' });
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('the route is a key into the map, so a URL cannot be injected', async () => {
    // Unlike the login page's `next`, which took a raw path, this indexes
    // APP_ROUTES — so an attacker-supplied destination is not reachable.
    await boot();
    await send({ type: 'navigate', route: 'https://evil.example' });
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('an inherited property name is not treated as a route', async () => {
    // This used to navigate. `ROUTES[route]` was a bare object index, so
    // 'constructor' and 'toString' resolved to functions off the prototype,
    // were truthy, and the page called wixLocation.to with a function —
    // '__proto__' handed it Object.prototype. Nothing attacker-chosen at the
    // far end, but a message naming any inherited property made the page
    // navigate when it should have done nothing.
    await boot();
    for (const route of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      await send({ type: 'navigate', route });
    }
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('logging out ends the session and leaves the page', async () => {
    await boot();
    await act('logoutBackroom');

    expect(wixLocation.to).toHaveBeenCalledWith(APP_ROUTES.home);
    expect(fake.rows('StaffSessions').every((s) => s.active === false)).toBe(true);
  });

  test('the menu logout does the same', async () => {
    await boot();
    await send({ type: 'menuAction', action: 'logout' });
    expect(wixLocation.to).toHaveBeenCalledWith('/myroom-home');
    expect(fake.rows('StaffSessions').every((s) => s.active === false)).toBe(true);
  });

  test('a menu reload just refreshes the snapshot', async () => {
    await boot();
    const before = html.postedOfType('adminSnapshot').length;
    await send({ type: 'menuAction', action: 'reload' });
    expect(html.postedOfType('adminSnapshot').length).toBe(before + 1);
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('an unknown menu action does nothing', async () => {
    await boot();
    const before = html.posted.length;
    await send({ type: 'menuAction', action: 'selfDestruct' });
    expect(html.posted).toHaveLength(before);
    expect(wixLocation.to).not.toHaveBeenCalled();
  });
});

describe('bridge telemetry', () => {
  test('a snapshot can be requested', async () => {
    await boot();
    await send({ type: 'requestBridgeTelemetry' });
    expect(html.postedOfType('bridgeTelemetrySnapshot').pop().telemetry).toMatchObject({ originChecks: expect.any(Number) });
  });

  test('the counters can be reset from the panel', async () => {
    await boot();
    await send({ type: 'requestBridgeTelemetry' });
    const before = html.postedOfType('bridgeTelemetrySnapshot').pop().telemetry.originChecks;
    expect(before).toBeGreaterThan(0);

    await act('resetBridgeTelemetry');

    const after = html.postedOfType('bridgeTelemetrySnapshot').pop().telemetry;
    // The reset itself is one more origin check, so this counts from zero again
    // rather than being zero outright.
    expect(after.originChecks).toBeLessThan(before);
  });
});

describe('resizing the panel', () => {
  test('a sensible height is applied', async () => {
    await boot();
    await send({ type: 'resize', height: 3000 });
    expect(html.height).toBe(3000);
  });

  test('the range is this page\'s own, 1200 to 7800', async () => {
    await boot();
    await send({ type: 'resize', height: 10 });
    expect(html.height).toBe(1200);
    await send({ type: 'resize', height: 999999 });
    expect(html.height).toBe(7800);
  });

  test('a resize with no height at all still sets the floor', async () => {
    // Unlike the other two pages, which ignore a missing height: here the clamp
    // raises 0 to 1200 before the truthiness check, so the panel is resized to
    // the minimum rather than left alone.
    await boot();
    await send({ type: 'resize' });
    expect(html.height).toBe(1200);
  });

  test('a non-numeric height is ignored', async () => {
    await boot();
    await send({ type: 'resize', height: 'tall' });
    expect(html.height).toBeUndefined();
  });
});

describe('when a backend call fails outright', () => {
  test('the error is surfaced as a toast and the busy flag is cleared', async () => {
    // The write is broken, not the read: pricingAdmin's own lookups swallow
    // their failures and answer null, so a broken *read* turns an update into
    // an insert and still reports success. Only a failing write surfaces.
    await boot();
    wixData.update = () => Promise.reject(new Error('InsurancePlans is offline'));
    wixData.insert = () => Promise.reject(new Error('InsurancePlans is offline'));

    await act('upsertInsurancePlan', { key: 'cdw', label: 'CDW', pricePerDay: 42 });

    expect(lastToast()).toMatchObject({ tone: 'error' });
    expect(html.postedOfType('busy').pop()).toEqual({ type: 'busy', flag: false });
  });

  test('a lookup that fails turns an update into an insert, and still reports success', async () => {
    // Worth pinning because it is surprising: queryFirstByField catches its own
    // error and returns null, which upsertByKey reads as "no such row yet".
    // With reads down and writes up, saving an existing plan adds a second one.
    await boot();
    const original = wixData.query;
    wixData.query = (collection) => {
      if (collection === 'InsurancePlans') throw new Error('InsurancePlans reads are offline');
      return original(collection);
    };
    try {
      await act('upsertInsurancePlan', { key: 'cdw', label: 'CDW', pricePerDay: 42 });
      expect(lastToast()).toMatchObject({ tone: 'success' });
      expect(fake.rows('InsurancePlans').filter((p) => p.key === 'cdw').length).toBeGreaterThan(1);
    } finally {
      wixData.query = original;
    }
  });

  test('a failing snapshot still clears the busy flag', async () => {
    await boot();
    const original = wixData.query;
    wixData.query = () => { throw new Error('everything is offline'); };
    try {
      await send({ type: 'pricingAdminReady' });
      expect(html.postedOfType('busy').pop()).toEqual({ type: 'busy', flag: false });
      expect(lastToast()).toMatchObject({ tone: 'error' });
    } finally {
      wixData.query = original;
    }
  });
});
