import wixLocation from 'wix-location';
import { local, session } from 'wix-storage';
import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../../backend/staffAccess.jsw';
import {
  getSessionToken,
  storeSessionToken,
  clearSessionToken,
  readBackroomSession,
  hasBackroomPermission,
  requireBackroomAccess,
  logoutBackroom,
  buildUserContext,
} from '../backroomAuth.js';

// The guard every backroom page runs before it renders anything. It decides
// whether the operator is signed in, whether they may see this particular
// screen, and where to send them if not — and it holds the session token in
// browser storage.
//
// Nothing in src/public had a test. This one is worth having because a guard
// that fails open is indistinguishable from one that works, right up until it
// matters.

const STORAGE_KEY = 'diamond.backroom.session';
const STAFF = 'staff@example.com';
const VIEWER = 'viewer@example.com';
const PASSWORD = 'correct-horse-battery';

function credential(email) {
  const passwordSalt = randomHex(16);
  return {
    _id: `cred-${email}`, email, passwordSalt,
    passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true,
  };
}

function seed() {
  return {
    StaffRoles: [
      { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true },
      { _id: 'role-viewer', key: 'viewer', label: 'Viewer', active: true, bookingsView: true, specialPermissions: '' },
    ],
    StaffUsers: [
      { _id: 'u-1', email: STAFF, fullName: 'A Operator', roleKey: 'admin', active: true },
      { _id: 'u-2', email: VIEWER, fullName: 'A Viewer', roleKey: 'viewer', active: true },
    ],
    StaffCredentials: [credential(STAFF), credential(VIEWER)],
    StaffSessions: [],
    StaffAuditLog: [],
  };
}

let fake;
function install() {
  fake = createFakeWixData(seed()).install(wixData);
  return fake;
}
async function signIn(email = STAFF) {
  const { sessionToken } = await loginStaff({ email, password: PASSWORD });
  return sessionToken;
}

beforeEach(() => {
  local.clear();
  session.clear();
  wixLocation.path = [];
  wixLocation.to = jest.fn();
});

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('where the session token is kept', () => {
  test('storing without remember-me writes both stores', async () => {
    // Local so a second tab can reuse the session, session so the current tab
    // keeps working where local storage is unavailable.
    storeSessionToken('tok-1', false);
    expect(local.getItem(STORAGE_KEY)).toBe('tok-1');
    expect(session.getItem(STORAGE_KEY)).toBe('tok-1');
  });

  test('storing with remember-me writes only the durable store', async () => {
    storeSessionToken('tok-1', true);
    expect(local.getItem(STORAGE_KEY)).toBe('tok-1');
    expect(session.getItem(STORAGE_KEY)).toBeNull();
  });

  test('remember-me defaults to off', async () => {
    storeSessionToken('tok-1');
    expect(session.getItem(STORAGE_KEY)).toBe('tok-1');
  });

  test('storing clears whatever was there first', async () => {
    storeSessionToken('old', true);
    storeSessionToken('new', false);
    expect(local.getItem(STORAGE_KEY)).toBe('new');
    expect(session.getItem(STORAGE_KEY)).toBe('new');
  });

  test('storing a blank token clears rather than storing an empty session', async () => {
    storeSessionToken('tok-1', false);
    storeSessionToken('   ');
    expect(getSessionToken()).toBe('');
    expect(local.getItem(STORAGE_KEY)).toBeNull();
    expect(session.getItem(STORAGE_KEY)).toBeNull();
  });

  test('reading prefers the durable store, then the per-tab one', async () => {
    session.setItem(STORAGE_KEY, 'from-session');
    expect(getSessionToken()).toBe('from-session');
    local.setItem(STORAGE_KEY, 'from-local');
    expect(getSessionToken()).toBe('from-local');
  });

  test('reading with nothing stored gives an empty string, not null', async () => {
    expect(getSessionToken()).toBe('');
  });

  test('clearing empties both stores', async () => {
    storeSessionToken('tok-1', false);
    clearSessionToken();
    expect(getSessionToken()).toBe('');
  });

  test('a storage backend that throws does not take the page down', async () => {
    const realSet = local.setItem;
    local.setItem = () => { throw new Error('storage disabled'); };
    try {
      expect(() => storeSessionToken('tok-1', false)).not.toThrow();
      // The per-tab store still took it, so the current tab keeps working.
      expect(session.getItem(STORAGE_KEY)).toBe('tok-1');
    } finally {
      local.setItem = realSet;
    }
  });
});

describe('reading the backroom session', () => {
  test('resolves a stored token to the signed-in operator', async () => {
    install();
    storeSessionToken(await signIn(), true);

    const state = await readBackroomSession();
    expect(state.authenticated).toBe(true);
    expect(state.email).toBe(STAFF);
    expect(state.sessionToken).toBeTruthy();
  });

  test('with no token stored it reports unauthenticated without asking the server', async () => {
    install();
    const state = await readBackroomSession();
    expect(state).toEqual({ authenticated: false, sessionToken: '' });
  });

  test('a token the server rejects is cleared from storage', async () => {
    // Otherwise a stale token would be re-sent on every page load forever.
    install();
    storeSessionToken('not-a-real-token', true);

    const state = await readBackroomSession();
    expect(state.authenticated).toBe(false);
    expect(getSessionToken()).toBe('');
  });

  test('a lookup that throws is treated as unauthenticated, and clears the token', async () => {
    install();
    storeSessionToken(await signIn(), true);
    const original = wixData.query;
    wixData.query = () => { throw new Error('backend unreachable'); };
    try {
      const state = await readBackroomSession();
      expect(state).toEqual({ authenticated: false, sessionToken: '' });
      expect(getSessionToken()).toBe('');
    } finally {
      wixData.query = original;
    }
  });
});

describe('checking a permission', () => {
  test('an empty area needs no permission', async () => {
    expect(hasBackroomPermission({}, '')).toBe(true);
    expect(hasBackroomPermission({}, '   ')).toBe(true);
  });

  test('the area and action are joined into the stored field name', async () => {
    expect(hasBackroomPermission({ bookingsView: true }, 'bookings', 'View')).toBe(true);
    expect(hasBackroomPermission({ bookingsEdit: true }, 'bookings', 'Edit')).toBe(true);
    expect(hasBackroomPermission({ bookingsView: true }, 'bookings', 'Edit')).toBe(false);
  });

  test('the action defaults to View', async () => {
    expect(hasBackroomPermission({ bookingsView: true }, 'bookings')).toBe(true);
  });

  test('the action is capitalised however it was written', async () => {
    expect(hasBackroomPermission({ bookingsEdit: true }, 'bookings', 'edit')).toBe(true);
    expect(hasBackroomPermission({ bookingsEdit: true }, 'bookings', 'EDIT')).toBe(true);
    expect(hasBackroomPermission({ bookingsEdit: true }, 'bookings', 'eDiT')).toBe(true);
  });

  test('an empty action falls back to View rather than to a bare area name', async () => {
    expect(hasBackroomPermission({ bookingsView: true }, 'bookings', '')).toBe(true);
  });

  test('a missing permission map denies rather than throwing', async () => {
    expect(hasBackroomPermission(undefined, 'bookings', 'View')).toBe(false);
    expect(hasBackroomPermission({}, 'bookings', 'View')).toBe(false);
  });

  test('a falsy stored value denies', async () => {
    expect(hasBackroomPermission({ bookingsView: false }, 'bookings')).toBe(false);
    expect(hasBackroomPermission({ bookingsView: '' }, 'bookings')).toBe(false);
  });

  test('the area is not case-folded, so it must match how it is stored', async () => {
    // Only the action is capitalised; the area is used verbatim. Worth stating,
    // because it means "Bookings" and "bookings" are different permissions.
    expect(hasBackroomPermission({ bookingsView: true }, 'Bookings')).toBe(false);
  });
});

describe('guarding a page', () => {
  test('lets a permitted operator through', async () => {
    install();
    storeSessionToken(await signIn(), true);

    const result = await requireBackroomAccess({ area: 'bookings', action: 'View' });
    expect(result.ok).toBe(true);
    expect(result.email).toBe(STAFF);
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('redirects a signed-out visitor, and says where they were going', async () => {
    install();
    wixLocation.path = ['myroom-bookingboard'];

    const result = await requireBackroomAccess({ area: 'bookings', action: 'View' });
    expect(result.ok).toBe(false);
    expect(wixLocation.to).toHaveBeenCalledWith('/myroom-home?next=%2Fmyroom-bookingboard');
  });

  test('a signed-out visitor is not marked as denied', async () => {
    // `denied` distinguishes "you may not see this" from "please sign in", and
    // the login screen shows a different message for each.
    install();
    wixLocation.path = ['myroom-bookingboard'];
    await requireBackroomAccess({ area: 'bookings' });
    expect(wixLocation.to.mock.calls[0][0]).not.toContain('denied');
  });

  test('a signed-in operator without the permission is redirected as denied', async () => {
    install();
    storeSessionToken(await signIn(VIEWER), true);
    wixLocation.path = ['myroom-contract'];

    const result = await requireBackroomAccess({ area: 'rentals', action: 'Edit' });
    expect(result.ok).toBe(false);
    expect(result.authenticated).toBe(true);
    const target = wixLocation.to.mock.calls[0][0];
    expect(target).toContain('denied=1');
    expect(target).toContain('next=%2Fmyroom-contract');
  });

  test('a redirect from the root carries no next parameter', async () => {
    install();
    wixLocation.path = [];
    await requireBackroomAccess({ area: 'bookings' });
    expect(wixLocation.to).toHaveBeenCalledWith('/myroom-home');
  });

  test('the redirect target can be overridden', async () => {
    install();
    wixLocation.path = [];
    await requireBackroomAccess({ area: 'bookings', redirectTo: '/home-login' });
    expect(wixLocation.to).toHaveBeenCalledWith('/home-login');
  });

  test('a nested path is joined and encoded', async () => {
    install();
    wixLocation.path = ['myroom-contract', 'bk-1'];
    await requireBackroomAccess({ area: 'rentals' });
    expect(wixLocation.to).toHaveBeenCalledWith('/myroom-home?next=%2Fmyroom-contract%2Fbk-1');
  });

  test('a guard with no area only requires being signed in', async () => {
    install();
    storeSessionToken(await signIn(VIEWER), true);
    const result = await requireBackroomAccess({});
    expect(result.ok).toBe(true);
  });

  test('but being signed out still fails a guard with no area', async () => {
    install();
    const result = await requireBackroomAccess({});
    expect(result.ok).toBe(false);
    expect(wixLocation.to).toHaveBeenCalled();
  });

  test('a navigation that throws does not stop the guard from reporting', async () => {
    install();
    wixLocation.to = jest.fn(() => { throw new Error('navigation blocked'); });
    const result = await requireBackroomAccess({ area: 'bookings' });
    expect(result.ok).toBe(false);
  });
});

describe('logging out', () => {
  test('clears the stored token and revokes the server session', async () => {
    // The session row is revoked in place rather than deleted — it keeps
    // `revokedAt` and goes inactive, so a sign-out stays on the record.
    install();
    storeSessionToken(await signIn(), true);
    expect(fake.rows('StaffSessions')).toHaveLength(1);

    await expect(logoutBackroom()).resolves.toBe(true);
    expect(getSessionToken()).toBe('');

    const [row] = fake.rows('StaffSessions');
    expect(row.active).toBe(false);
    expect(row.revokedAt).toBeTruthy();
  });

  test('and the revoked session no longer authenticates', async () => {
    install();
    const tokenValue = await signIn();
    storeSessionToken(tokenValue, true);
    await logoutBackroom();

    storeSessionToken(tokenValue, true);
    expect((await readBackroomSession()).authenticated).toBe(false);
  });

  test('the token is cleared before the server is told, so a failure cannot strand it', async () => {
    install();
    storeSessionToken(await signIn(), true);
    const original = wixData.query;
    wixData.query = () => { throw new Error('backend unreachable'); };
    try {
      await expect(logoutBackroom()).resolves.toBe(true);
      expect(getSessionToken()).toBe('');
    } finally {
      wixData.query = original;
    }
  });

  test('logging out with no token stored does not reach the server at all', async () => {
    // The guard is duplicated: logoutStaff itself returns early on an empty
    // token without querying anything, so removing logoutBackroom's own
    // `if (sessionToken)` changes nothing observable. Kept because stating the
    // intent at the call site is worth a redundant line — and this asserts the
    // behaviour that matters either way.
    install();
    const collections = [];
    const original = wixData.query;
    wixData.query = (collection) => { collections.push(collection); return original(collection); };
    try {
      await expect(logoutBackroom()).resolves.toBe(true);
      expect(collections).toEqual([]);
    } finally {
      wixData.query = original;
    }
  });
});

describe('the context handed to an embedded page', () => {
  test('carries the operator identity', async () => {
    expect(buildUserContext({ fullName: 'A Operator', roleLabel: 'Admin', email: STAFF })).toMatchObject({
      type: 'userContext', name: 'A Operator', role: 'Admin', email: STAFF,
    });
  });

  test('falls back to generic labels for an unknown operator', async () => {
    expect(buildUserContext({})).toMatchObject({
      name: 'Operator', role: 'Backroom', email: '',
      company: 'DIAMOND Backroom', station: 'Operations Center',
    });
  });

  test('survives being given nothing at all', async () => {
    expect(buildUserContext().name).toBe('Operator');
  });

  test('the must-change-password flag is always a boolean', async () => {
    expect(buildUserContext({ mustChangePassword: 'yes' }).mustChangePassword).toBe(true);
    expect(buildUserContext({}).mustChangePassword).toBe(false);
  });

  test('extra fields are merged, and may override any default', async () => {
    // Including the last one in the literal. Testing only an early key would
    // pass however the spread were ordered.
    const ctx = buildUserContext(
      { fullName: 'A', mustChangePassword: true },
      { station: 'Thessaloniki', extra: 1, mustChangePassword: false },
    );
    expect(ctx.station).toBe('Thessaloniki');
    expect(ctx.extra).toBe(1);
    expect(ctx.mustChangePassword).toBe(false);
  });
});
