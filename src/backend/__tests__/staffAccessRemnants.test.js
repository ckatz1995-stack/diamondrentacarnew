import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import {
  getPublicLoginBootstrap,
  getPublicAuthHealth,
  getBootstrapHelp,
  loginStaff,
  getSessionState,
  authorizeStaffRoute,
  revokeStaffSessions,
  requestAccessRecovery,
  derivePasswordHash,
  randomHex,
  sha256,
} from '../staffAccess.jsw';

// The corners of staffAccess the other five suites do not reach: the role
// bootstrap that only runs on a site with no roles yet, the route authoriser,
// session revocation by record id, and the password derivation's compat path
// for a runtime with no crypto module.

const PASSWORD = 'correct-horse-battery';
const ADMIN = 'admin@example.com';
const DESK = 'desk@example.com';

function credential(email, extra = {}) {
  const passwordSalt = randomHex(16);
  return {
    _id: `cred-${email}`, email, passwordSalt,
    passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true, ...extra,
  };
}

function seed({ roles = null, users = null, creds = null } = {}) {
  return {
    StaffRoles: roles ?? [
      { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true },
      {
        _id: 'role-desk', key: 'desk', label: 'Desk', active: true,
        bookingsView: true, bookingsEdit: true, rentalsView: true, specialPermissions: '',
      },
    ],
    StaffUsers: users ?? [
      { _id: 'u-1', email: ADMIN, fullName: 'The Admin', roleKey: 'admin', active: true },
      { _id: 'u-2', email: DESK, fullName: 'Desk Agent', roleKey: 'desk', active: true },
    ],
    StaffCredentials: creds ?? [credential(ADMIN), credential(DESK)],
    StaffSessions: [],
    StaffAuditLog: [],
  };
}

let fake;
const install = (options) => { fake = createFakeWixData(seed(options)).install(wixData); return fake; };
const token = async (email = ADMIN) => (await loginStaff({ email, password: PASSWORD })).sessionToken;

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('bootstrapping the roles collection', () => {
  test('a site with no roles gets the five shipped ones on first use', async () => {
    // Nothing else in the suite exercises this: every other seed already has
    // roles, so the branch that writes them has never run.
    install({ roles: [] });

    // And the login succeeds on the strength of them: the seeded admin role is
    // what gives the existing admin user a profile.
    await expect(loginStaff({ email: ADMIN, password: PASSWORD }))
      .resolves.toMatchObject({ success: true, profile: { roleKey: 'admin', isAdmin: true } });

    expect(fake.rows('StaffRoles').map((r) => r.key).sort())
      .toEqual(['admin', 'desk', 'finance', 'manager', 'viewer']);
  });

  test('the shipped admin role can do everything, and holds every special grant', async () => {
    install({ roles: [] });
    await loginStaff({ email: ADMIN, password: PASSWORD }).catch(() => null);

    const admin = fake.rows('StaffRoles').find((r) => r.key === 'admin');
    for (const module of ['bookings', 'rentals', 'customers', 'pricing', 'fleet', 'reports', 'financials']) {
      for (const action of ['View', 'Insert', 'Edit', 'Delete']) {
        expect(admin[`${module}${action}`]).toBe(true);
      }
    }
    expect(admin.specialPermissions.split('|').length).toBeGreaterThan(1);
  });

  test('the shipped viewer role can look at everything and change nothing', async () => {
    install({ roles: [] });
    await loginStaff({ email: ADMIN, password: PASSWORD }).catch(() => null);

    const viewer = fake.rows('StaffRoles').find((r) => r.key === 'viewer');
    expect(viewer.bookingsView).toBe(true);
    expect(viewer.bookingsEdit).toBeFalsy();
    expect(viewer.bookingsDelete).toBeFalsy();
    expect(viewer.specialPermissions).toBe('viewChangeHistory');
  });

  test('the shipped manager role can do everything except delete', async () => {
    install({ roles: [] });
    await loginStaff({ email: ADMIN, password: PASSWORD }).catch(() => null);

    const manager = fake.rows('StaffRoles').find((r) => r.key === 'manager');
    expect(manager.bookingsEdit).toBe(true);
    expect(manager.bookingsInsert).toBe(true);
    expect(manager.bookingsDelete).toBeFalsy();
  });

  test('the shipped desk role sees the fleet but cannot change it', async () => {
    install({ roles: [] });
    await loginStaff({ email: ADMIN, password: PASSWORD }).catch(() => null);

    const desk = fake.rows('StaffRoles').find((r) => r.key === 'desk');
    expect(desk.bookingsEdit).toBe(true);
    expect(desk.fleetView).toBe(true);
    expect(desk.fleetEdit).toBeFalsy();
  });

  test('the shipped finance role edits money and pricing but only reads bookings', async () => {
    install({ roles: [] });
    await loginStaff({ email: ADMIN, password: PASSWORD }).catch(() => null);

    const finance = fake.rows('StaffRoles').find((r) => r.key === 'finance');
    expect(finance.financialsEdit).toBe(true);
    expect(finance.pricingEdit).toBe(true);
    expect(finance.bookingsView).toBe(true);
    expect(finance.bookingsEdit).toBeFalsy();
  });

  test('a site that already has roles is left alone', async () => {
    install();

    await loginStaff({ email: ADMIN, password: PASSWORD });

    expect(fake.rows('StaffRoles').map((r) => r.key).sort()).toEqual(['admin', 'desk']);
  });

  test('the bootstrap runs once, not once per call', async () => {
    install({ roles: [] });

    await loginStaff({ email: ADMIN, password: PASSWORD }).catch(() => null);
    await loginStaff({ email: ADMIN, password: PASSWORD }).catch(() => null);

    expect(fake.rows('StaffRoles')).toHaveLength(5);
  });

  test('a collection that refuses the writes leaves the site usable rather than failing', async () => {
    install({ roles: [] });
    const original = wixData.insert;
    wixData.insert = (collection, ...rest) => (
      collection === 'StaffRoles'
        ? Promise.reject(new Error('collection is read-only'))
        : original.call(wixData, collection, ...rest)
    );
    try {
      // The login still fails for its own reason — no role means no profile —
      // but it fails cleanly rather than propagating the write error.
      await expect(loginStaff({ email: ADMIN, password: PASSWORD })).rejects.not.toThrow('collection is read-only');
    } finally {
      wixData.insert = original;
    }

    expect(fake.rows('StaffRoles')).toEqual([]);
  });
});

describe('authorizeStaffRoute', () => {
  test('an operator with the permission is allowed, and gets their state back', async () => {
    install();
    const sessionToken = await token(DESK);

    const res = await authorizeStaffRoute({ sessionToken, area: 'bookings', action: 'View' });

    expect(res).toMatchObject({ authenticated: true, allowed: true, email: DESK, roleKey: 'desk' });
  });

  test('an operator without the permission is authenticated but not allowed', async () => {
    install();
    const sessionToken = await token(DESK);

    const res = await authorizeStaffRoute({ sessionToken, area: 'financials', action: 'View' });

    expect(res).toMatchObject({ authenticated: true, allowed: false });
  });

  test('the action matters, not only the area', async () => {
    install();
    const sessionToken = await token(DESK);

    expect((await authorizeStaffRoute({ sessionToken, area: 'rentals', action: 'View' })).allowed).toBe(true);
    expect((await authorizeStaffRoute({ sessionToken, area: 'rentals', action: 'Edit' })).allowed).toBe(false);
  });

  test('an admin is allowed anything', async () => {
    install();
    const sessionToken = await token(ADMIN);

    expect((await authorizeStaffRoute({ sessionToken, area: 'financials', action: 'Delete' })).allowed).toBe(true);
  });

  test('no area at all means the question is just "are you signed in"', async () => {
    install();
    const sessionToken = await token(DESK);

    expect((await authorizeStaffRoute({ sessionToken })).allowed).toBe(true);
  });

  test('an unknown token is neither authenticated nor allowed, and leaks nothing else', async () => {
    install();

    const res = await authorizeStaffRoute({ sessionToken: 'f'.repeat(64), area: 'bookings' });

    expect(res).toEqual({ authenticated: false, allowed: false });
  });

  test('no token at all is refused the same way', async () => {
    install();

    expect(await authorizeStaffRoute({})).toEqual({ authenticated: false, allowed: false });
  });

  test('a revoked session stops being authorised', async () => {
    install();
    const sessionToken = await token(DESK);
    expect((await authorizeStaffRoute({ sessionToken, area: 'bookings' })).allowed).toBe(true);

    const row = fake.rows('StaffSessions')[0];
    await wixData.update('StaffSessions', { ...row, active: false }, { suppressAuth: true });

    expect(await authorizeStaffRoute({ sessionToken, area: 'bookings' }))
      .toEqual({ authenticated: false, allowed: false });
  });
});

describe('revoking a single session by its record id', () => {
  test('the named session is revoked and counted', async () => {
    install();
    const adminToken = await token();
    const deskToken = await token(DESK);
    const deskRow = fake.rows('StaffSessions').find((s) => s.tokenHash === sha256(deskToken));

    const res = await revokeStaffSessions({ sessionToken: adminToken, itemId: deskRow._id });

    expect(res).toMatchObject({ revoked: 1 });
    expect(fake.rows('StaffSessions').find((s) => s._id === deskRow._id).active).toBe(false);
    expect(await getSessionState({ sessionToken: deskToken })).toMatchObject({ authenticated: false });
  });

  test('the revoked session is stamped with the time it was cut off', async () => {
    install();
    const adminToken = await token();
    const deskToken = await token(DESK);
    const deskRow = fake.rows('StaffSessions').find((s) => s.tokenHash === sha256(deskToken));

    await revokeStaffSessions({ sessionToken: adminToken, itemId: deskRow._id });

    expect(fake.rows('StaffSessions').find((s) => s._id === deskRow._id).revokedAt).toBeInstanceOf(Date);
  });

  test('an operator can spare their own session while revoking by id', async () => {
    install();
    const adminToken = await token();
    const ownRow = fake.rows('StaffSessions')[0];

    const res = await revokeStaffSessions({ sessionToken: adminToken, itemId: ownRow._id, exceptCurrent: true });

    expect(res).toMatchObject({ revoked: 0 });
    expect(await getSessionState({ sessionToken: adminToken })).toMatchObject({ authenticated: true });
  });

  test('without that flag an operator can sign themselves out by id', async () => {
    install();
    const adminToken = await token();
    const ownRow = fake.rows('StaffSessions')[0];

    const res = await revokeStaffSessions({ sessionToken: adminToken, itemId: ownRow._id });

    expect(res).toMatchObject({ revoked: 1 });
    expect(await getSessionState({ sessionToken: adminToken })).toMatchObject({ authenticated: false });
  });

  test('a session that is already revoked is not counted twice', async () => {
    install();
    const adminToken = await token();
    const deskToken = await token(DESK);
    const deskRow = fake.rows('StaffSessions').find((s) => s.tokenHash === sha256(deskToken));

    await revokeStaffSessions({ sessionToken: adminToken, itemId: deskRow._id });
    const second = await revokeStaffSessions({ sessionToken: adminToken, itemId: deskRow._id });

    expect(second).toMatchObject({ revoked: 0 });
  });

  test('an id that matches nothing revokes nothing rather than failing', async () => {
    install();
    const adminToken = await token();

    expect(await revokeStaffSessions({ sessionToken: adminToken, itemId: 'no-such-session' }))
      .toMatchObject({ revoked: 0 });
  });

  test('an operator without the staff-management grant is refused', async () => {
    install();
    const deskToken = await token(DESK);
    const row = fake.rows('StaffSessions')[0];

    await expect(revokeStaffSessions({ sessionToken: deskToken, itemId: row._id }))
      .rejects.toThrow();
  });
});

describe('the password derivation compat path', () => {
  // A Velo runtime without Node's crypto module. The site still has to be able
  // to sign people in, so derivePasswordHash falls back to iterated sha256 —
  // weaker than PBKDF2 and worth knowing is there, which is why it is pinned
  // rather than left to run untested if it ever fires in production.
  const withoutPbkdf2 = async (fn) => {
    const cryptoUtils = await import('../cryptoUtils.js');
    const original = cryptoUtils.getCrypto;
    const real = original();
    cryptoUtils.getCrypto = () => ({
      createHash: real.createHash.bind(real),
      randomBytes: real.randomBytes.bind(real),
      timingSafeEqual: real.timingSafeEqual.bind(real),
    });
    try { return await fn(); } finally { cryptoUtils.getCrypto = original; }
  };

  test('it still produces a 64-character hex digest', async () => {
    await withoutPbkdf2(async () => {
      expect(derivePasswordHash('a-password', 'a-salt')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  test('it is deterministic for the same password and salt', async () => {
    await withoutPbkdf2(async () => {
      expect(derivePasswordHash('a-password', 'a-salt')).toBe(derivePasswordHash('a-password', 'a-salt'));
    });
  });

  test('it separates passwords, and separates salts', async () => {
    await withoutPbkdf2(async () => {
      expect(derivePasswordHash('a-password', 'a-salt')).not.toBe(derivePasswordHash('b-password', 'a-salt'));
      expect(derivePasswordHash('a-password', 'a-salt')).not.toBe(derivePasswordHash('a-password', 'b-salt'));
    });
  });

  test('it does not agree with the PBKDF2 path, so the two are never interchangeable', async () => {
    // Worth stating: a site that loses its crypto module cannot verify hashes
    // written while it had one. The fallback is a way to keep running, not a
    // drop-in replacement.
    const native = derivePasswordHash('a-password', 'a-salt');
    const compat = await withoutPbkdf2(async () => derivePasswordHash('a-password', 'a-salt'));

    expect(compat).not.toBe(native);
  });

  test('an empty password and salt are still hashed rather than refused', async () => {
    await withoutPbkdf2(async () => {
      expect(derivePasswordHash('', '')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  test('the two paths disagree about a nullish password', async () => {
    // Pinned as a discrepancy, not as a feature. The PBKDF2 path coerces with
    // String(password || ''), so undefined and '' hash alike; the fallback
    // interpolates into a template literal, where undefined becomes the text
    // "undefined". It cannot matter today — every caller passes a string, and
    // the two paths already produce different digests for the same input, so a
    // hash is only ever verified by the path that wrote it — but the asymmetry
    // is the kind that stops being harmless the moment someone reuses one of
    // these helpers somewhere new.
    const nativeEmpty = derivePasswordHash('', '');
    const nativeUndefined = derivePasswordHash(undefined, undefined);
    expect(nativeUndefined).toBe(nativeEmpty);

    await withoutPbkdf2(async () => {
      expect(derivePasswordHash(undefined, undefined)).not.toBe(derivePasswordHash('', ''));
    });
  });

  test('a login made under the compat path verifies under it', async () => {
    await withoutPbkdf2(async () => {
      const salt = randomHex(16);
      fake = createFakeWixData(seed({
        creds: [{ _id: 'c1', email: ADMIN, passwordSalt: salt, passwordHash: derivePasswordHash(PASSWORD, salt), active: true }],
      })).install(wixData);

      await expect(loginStaff({ email: ADMIN, password: PASSWORD }))
        .resolves.toMatchObject({ sessionToken: expect.any(String) });
    });
  });
});

describe('the recovery rate limit when the audit log is unreadable', () => {
  test('an unreadable audit log does not block a recovery request', async () => {
    // hasRecentRecoveryRequest swallows the query error and answers "no recent
    // request", so a broken audit collection cannot lock every operator out of
    // recovery. The alternative — failing closed — would be worse here.
    install();
    const original = wixData.query;
    wixData.query = (collection) => {
      if (collection === 'StaffAuditLog') throw new Error('collection missing');
      return original.call(wixData, collection);
    };
    try {
      await expect(requestAccessRecovery({ email: ADMIN })).resolves.toMatchObject({ success: true });
    } finally {
      wixData.query = original;
    }
  });
});

describe('the public diagnostic endpoints', () => {
  // All three are browser-callable, so what they must NOT say is as important
  // as what they do: no collection names, no counts, no admin addresses, and no
  // hint about whether a bootstrap is currently possible.
  const leaks = (value) => {
    const blob = JSON.stringify(value);
    expect(blob).not.toMatch(/StaffUsers|StaffCredentials|StaffSessions|StaffAuditLog|StaffRoles/);
    expect(blob).not.toMatch(/@example\.com/);
    expect(blob).not.toMatch(/passwordHash|passwordSalt|tokenHash/);
  };

  test('the login bootstrap reports ready, private, and nothing else', async () => {
    install();

    const res = await getPublicLoginBootstrap();

    expect(res).toMatchObject({ ready: true, bootstrapAvailable: false, bootstrapMode: 'private' });
    expect(res.cryptoMode).toMatch(/^(native|compat)$/);
    leaks(res);
  });

  test('the auth health probe reports ok and the crypto mode', async () => {
    install();

    const res = await getPublicAuthHealth();

    expect(res).toMatchObject({ ok: true, bootstrapAvailable: false, bootstrapMode: 'private' });
    expect(res.cryptoMode).toMatch(/^(native|compat)$/);
    leaks(res);
  });

  test('the bootstrap help names the secret to set, not the value', async () => {
    install();

    const res = await getBootstrapHelp();

    expect(res).toMatchObject({ bootstrapAvailable: false, bootstrapMode: 'private' });
    expect(res.setupHint).toContain('BACKROOM_BOOTSTRAP_PASSWORD');
    leaks(res);
  });

  test('none of them needs a session, and none of them changes anything', async () => {
    install();
    const before = JSON.stringify(fake.rows('StaffSessions'));

    await Promise.all([getPublicLoginBootstrap(), getPublicAuthHealth(), getBootstrapHelp()]);

    expect(JSON.stringify(fake.rows('StaffSessions'))).toBe(before);
  });

  test('they report the compat crypto mode when the runtime has no crypto', async () => {
    install();
    const cryptoUtils = await import('../cryptoUtils.js');
    const original = cryptoUtils.getCrypto;
    cryptoUtils.getCrypto = () => null;
    try {
      expect((await getPublicAuthHealth()).cryptoMode).toBe('compat');
      expect((await getPublicLoginBootstrap()).cryptoMode).toBe('compat');
      expect((await getBootstrapHelp()).cryptoMode).toBe('compat');
    } finally {
      cryptoUtils.getCrypto = original;
    }
  });

  test('a partial crypto module is still reported as compat', async () => {
    // 'native' means all three primitives are there; anything less is compat,
    // because the fallbacks are what will actually run.
    install();
    const cryptoUtils = await import('../cryptoUtils.js');
    const original = cryptoUtils.getCrypto;
    const real = original();
    cryptoUtils.getCrypto = () => ({ createHash: real.createHash.bind(real) });
    try {
      expect((await getPublicAuthHealth()).cryptoMode).toBe('compat');
    } finally {
      cryptoUtils.getCrypto = original;
    }
  });
});

describe('how a boolean field is read off a record', () => {
  // readBool is what turns a CMS checkbox into a decision. Wix stores those as
  // real booleans, but an imported or hand-edited row can hold text, and the
  // must-change-password flag is the one place that difference is visible from
  // a login.
  const loginWith = async (mustChangePassword) => {
    fake = createFakeWixData(seed({
      creds: [credential(ADMIN, { mustChangePassword })],
    })).install(wixData);
    return loginStaff({ email: ADMIN, password: PASSWORD });
  };

  test.each([
    ['true', true],
    ['the text "true"', 'true'],
    ['the text "yes"', 'yes'],
    ['the text "y"', 'y'],
    ['the text "on"', 'on'],
    ['the text "1"', '1'],
    ['the text "TRUE" in caps', 'TRUE'],
    ['the number 1', 1],
  ])('%s means the password must be changed', async (_label, value) => {
    const res = await loginWith(value);

    expect(res.profile.mustChangePassword).toBe(true);
  });

  test.each([
    ['false', false],
    ['the text "false"', 'false'],
    ['the text "no"', 'no'],
    ['the number 0', 0],
    ['an unrecognised word', 'maybe'],
  ])('%s does not', async (_label, value) => {
    const res = await loginWith(value);

    expect(res.profile.mustChangePassword).toBe(false);
  });

  test.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['null', null],
    ['undefined', undefined],
  ])('%s falls back to the default rather than to false-by-coercion', async (_label, value) => {
    // The distinction that matters: a blank field means "not set", so the
    // caller's default decides. Here that default is false.
    const res = await loginWith(value);

    expect(res.profile.mustChangePassword).toBe(false);
  });
});
