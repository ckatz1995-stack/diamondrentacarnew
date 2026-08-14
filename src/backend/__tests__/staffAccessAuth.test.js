import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import {
  loginStaff,
  getSessionState,
  logoutStaff,
  requireStaffAccess,
  derivePasswordHash,
  randomHex,
  sha256,
} from '../staffAccess.jsw';

// Every rejected login must look identical from outside, or the error text
// becomes an account-enumeration oracle.
const GENERIC_LOGIN_ERROR = 'Λάθος email ή password.';

const PASSWORD = 'correct-horse-battery';

function credentialFor(email, password = PASSWORD, overrides = {}) {
  const passwordSalt = randomHex(16);
  return {
    _id: `cred-${email}`,
    email,
    passwordSalt,
    passwordHash: derivePasswordHash(password, passwordSalt),
    active: true,
    mustChangePassword: false,
    ...overrides,
  };
}

function seed({ user = {}, role = {}, credential = {} } = {}) {
  const email = 'staff@example.com';
  return {
    StaffRoles: [{
      _id: 'role-admin',
      key: 'admin',
      label: 'Administrator',
      active: true,
      sortOrder: 1,
      ...role,
    }],
    StaffUsers: [{
      _id: 'user-1',
      email,
      fullName: 'Staff Member',
      roleKey: 'admin',
      active: true,
      ...user,
    }],
    StaffCredentials: [credentialFor(email, PASSWORD, credential)],
    StaffSessions: [],
    StaffAuditLog: [],
  };
}

let fake;

function install(seedData) {
  fake = createFakeWixData(seedData).install(wixData);
  return fake;
}

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('loginStaff — success path', () => {
  test('returns a session token and an authenticated profile', async () => {
    install(seed());
    const result = await loginStaff({ email: 'staff@example.com', password: PASSWORD });
    expect(result.success).toBe(true);
    expect(typeof result.sessionToken).toBe('string');
    expect(result.sessionToken.length).toBeGreaterThan(0);
    expect(result.profile.authenticated).toBe(true);
    expect(result.profile.email).toBe('staff@example.com');
  });

  test('stores only a hash of the session token, never the token itself', async () => {
    // The security property that matters: a leaked sessions table must not hand
    // an attacker usable tokens.
    install(seed());
    const { sessionToken } = await loginStaff({ email: 'staff@example.com', password: PASSWORD });

    const sessions = fake.rows('StaffSessions');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].tokenHash).toBe(sha256(sessionToken));
    expect(JSON.stringify(sessions[0])).not.toContain(sessionToken);
  });

  test('accepts the email case-insensitively', async () => {
    install(seed());
    const result = await loginStaff({ email: 'STAFF@Example.COM', password: PASSWORD });
    expect(result.success).toBe(true);
  });

  test('issues a much longer-lived session when remember is set', async () => {
    install(seed());
    const normal = await loginStaff({ email: 'staff@example.com', password: PASSWORD });
    const remembered = await loginStaff({ email: 'staff@example.com', password: PASSWORD, remember: true });

    const normalMs = new Date(normal.expiresAt).getTime() - Date.now();
    const rememberedMs = new Date(remembered.expiresAt).getTime() - Date.now();
    // 12 hours vs 30 days.
    expect(normalMs).toBeLessThan(13 * 60 * 60 * 1000);
    expect(rememberedMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
  });

  test('records a successful login in the audit log', async () => {
    install(seed());
    await loginStaff({ email: 'staff@example.com', password: PASSWORD });
    const audit = fake.rows('StaffAuditLog');
    expect(audit.some((row) => row.action === 'loginSuccess')).toBe(true);
  });

  test('issues a distinct token per login', async () => {
    install(seed());
    const a = await loginStaff({ email: 'staff@example.com', password: PASSWORD });
    const b = await loginStaff({ email: 'staff@example.com', password: PASSWORD });
    expect(a.sessionToken).not.toBe(b.sessionToken);
  });
});

describe('loginStaff — rejection paths', () => {
  test('rejects a wrong password', async () => {
    install(seed());
    await expect(loginStaff({ email: 'staff@example.com', password: 'wrong' }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
  });

  test('rejects an unknown email with the same message as a wrong password', async () => {
    install(seed());
    await expect(loginStaff({ email: 'nobody@example.com', password: PASSWORD }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
  });

  test('rejects a deactivated user', async () => {
    install(seed({ user: { active: false } }));
    await expect(loginStaff({ email: 'staff@example.com', password: PASSWORD }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
  });

  test('rejects a user whose role has been deactivated', async () => {
    install(seed({ role: { active: false } }));
    await expect(loginStaff({ email: 'staff@example.com', password: PASSWORD }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
  });

  test('rejects deactivated credentials', async () => {
    install(seed({ credential: { active: false } }));
    await expect(loginStaff({ email: 'staff@example.com', password: PASSWORD }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
  });

  test('requires both an email and a password', async () => {
    install(seed());
    await expect(loginStaff({ email: '', password: PASSWORD })).rejects.toThrow();
    await expect(loginStaff({ email: 'staff@example.com', password: '' })).rejects.toThrow();
    await expect(loginStaff({})).rejects.toThrow();
  });

  test('creates no session when login fails', async () => {
    install(seed());
    await expect(loginStaff({ email: 'staff@example.com', password: 'wrong' })).rejects.toThrow();
    expect(fake.rows('StaffSessions')).toHaveLength(0);
  });

  test('records failed logins in the audit log', async () => {
    install(seed());
    await expect(loginStaff({ email: 'staff@example.com', password: 'wrong' })).rejects.toThrow();
    const audit = fake.rows('StaffAuditLog');
    expect(audit.some((row) => row.action === 'loginFailed')).toBe(true);
  });

  test('does not leak which factor failed across the different rejection paths', async () => {
    const messages = [];
    for (const [label, seedData, password] of [
      ['unknown email', seed(), PASSWORD],
      ['wrong password', seed(), 'wrong'],
      ['inactive user', seed({ user: { active: false } }), PASSWORD],
      ['inactive role', seed({ role: { active: false } }), PASSWORD],
      ['inactive credential', seed({ credential: { active: false } }), PASSWORD],
    ]) {
      install(seedData);
      const email = label === 'unknown email' ? 'nobody@example.com' : 'staff@example.com';
      await loginStaff({ email, password }).catch((err) => messages.push(err.message));
      fake.restore();
      fake = null;
    }
    expect(messages).toHaveLength(5);
    expect(new Set(messages).size).toBe(1);
  });
});

describe('getSessionState', () => {
  test('recognises a freshly issued token', async () => {
    install(seed());
    const { sessionToken } = await loginStaff({ email: 'staff@example.com', password: PASSWORD });
    const state = await getSessionState({ sessionToken });
    expect(state.authenticated).toBe(true);
    expect(state.email).toBe('staff@example.com');
  });

  test('rejects a missing, empty or unknown token', async () => {
    install(seed());
    expect((await getSessionState({ sessionToken: '' })).authenticated).toBe(false);
    expect((await getSessionState({})).authenticated).toBe(false);
    expect((await getSessionState({ sessionToken: 'made-up-token' })).authenticated).toBe(false);
  });

  test('rejects an expired session and deactivates it', async () => {
    install(seed());
    const { sessionToken } = await loginStaff({ email: 'staff@example.com', password: PASSWORD });

    const sessions = fake.rows('StaffSessions');
    await wixData.update('StaffSessions', { ...sessions[0], expiresAt: new Date(Date.now() - 1000) });

    expect((await getSessionState({ sessionToken })).authenticated).toBe(false);
    expect(fake.rows('StaffSessions')[0].active).toBe(false);
  });

  test('rejects a session whose user was deactivated after login', async () => {
    install(seed());
    const { sessionToken } = await loginStaff({ email: 'staff@example.com', password: PASSWORD });
    const [user] = fake.rows('StaffUsers');
    await wixData.update('StaffUsers', { ...user, active: false });
    expect((await getSessionState({ sessionToken })).authenticated).toBe(false);
  });

  test('rejects a session whose role was deactivated after login', async () => {
    install(seed());
    const { sessionToken } = await loginStaff({ email: 'staff@example.com', password: PASSWORD });
    const [role] = fake.rows('StaffRoles');
    await wixData.update('StaffRoles', { ...role, active: false });
    expect((await getSessionState({ sessionToken })).authenticated).toBe(false);
  });
});

describe('logoutStaff', () => {
  test('invalidates the session so the token stops working', async () => {
    install(seed());
    const { sessionToken } = await loginStaff({ email: 'staff@example.com', password: PASSWORD });
    expect((await getSessionState({ sessionToken })).authenticated).toBe(true);

    await logoutStaff({ sessionToken });

    expect((await getSessionState({ sessionToken })).authenticated).toBe(false);
    expect(fake.rows('StaffSessions')[0].active).toBe(false);
  });

  test('succeeds quietly for an unknown or empty token', async () => {
    install(seed());
    await expect(logoutStaff({ sessionToken: 'made-up' })).resolves.toMatchObject({ success: true });
    await expect(logoutStaff({})).resolves.toMatchObject({ success: true });
  });
});

describe('requireStaffAccess', () => {
  test('throws AUTH_REQUIRED without a valid session', async () => {
    install(seed());
    await expect(requireStaffAccess({ sessionToken: '' })).rejects.toThrow('AUTH_REQUIRED');
    await expect(requireStaffAccess({ sessionToken: 'made-up' })).rejects.toThrow('AUTH_REQUIRED');
  });

  test('lets an admin through to any area', async () => {
    install(seed());
    const { sessionToken } = await loginStaff({ email: 'staff@example.com', password: PASSWORD });
    const state = await requireStaffAccess({ sessionToken, area: 'pricing', action: 'Edit' });
    expect(state.authenticated).toBe(true);
  });

  test('throws AUTH_REQUIRED once the session has been logged out', async () => {
    install(seed());
    const { sessionToken } = await loginStaff({ email: 'staff@example.com', password: PASSWORD });
    await logoutStaff({ sessionToken });
    await expect(requireStaffAccess({ sessionToken, area: 'pricing' })).rejects.toThrow('AUTH_REQUIRED');
  });

  test('denies a non-admin role that lacks the area permission', async () => {
    install(seed({
      user: { roleKey: 'viewer' },
      role: { _id: 'role-viewer', key: 'viewer', label: 'Viewer', active: true },
    }));
    const { sessionToken } = await loginStaff({ email: 'staff@example.com', password: PASSWORD });
    await expect(requireStaffAccess({ sessionToken, area: 'pricing', action: 'Edit' }))
      .rejects.toThrow('ACCESS_DENIED');
  });
});
