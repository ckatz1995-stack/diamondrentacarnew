import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import * as staff from '../staffAccess.jsw';
import { loginStaff, getSessionState, derivePasswordHash, randomHex, sha256 } from '../staffAccess.jsw';

// The staff administration surface: who may create users, change roles, reset
// passwords and revoke sessions. Login and session handling are covered in
// staffAccessAuth.test.js; this covers what an authenticated caller can then do.

const ADMIN = 'admin@example.com';
const VIEWER = 'viewer@example.com';
const PASSWORD = 'correct-horse-battery';

function credential(email, password = PASSWORD) {
  const passwordSalt = randomHex(16);
  return {
    _id: `cred-${email}`,
    email,
    passwordSalt,
    passwordHash: derivePasswordHash(password, passwordSalt),
    active: true,
  };
}

function seed(extra = {}) {
  return {
    StaffRoles: [
      { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true, sortOrder: 1 },
      // A non-admin role with no special permissions at all.
      { _id: 'role-viewer', key: 'viewer', label: 'Viewer', active: true, sortOrder: 2, specialPermissions: '' },
    ],
    StaffUsers: [
      { _id: 'user-admin', email: ADMIN, fullName: 'Admin User', roleKey: 'admin', active: true },
      { _id: 'user-viewer', email: VIEWER, fullName: 'Viewer User', roleKey: 'viewer', active: true },
    ],
    StaffCredentials: [credential(ADMIN), credential(VIEWER)],
    StaffSessions: [],
    StaffAuditLog: [],
    ...extra,
  };
}

let fake;
function install(s = seed()) {
  fake = createFakeWixData(s).install(wixData);
  return fake;
}
async function tokenFor(email) {
  const { sessionToken } = await loginStaff({ email, password: PASSWORD });
  return sessionToken;
}
const userRow = (email) => fake.rows('StaffUsers').find((u) => u.email === email);
const sessionsFor = (email) => fake.rows('StaffSessions').filter((s) => s.email === email);

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

// Every export that changes staff records or credentials. Enumerated so a new
// admin endpoint added without the manageStaff gate fails this list.
const MANAGE_STAFF_EXPORTS = [
  ['upsertStaffRole', { payload: { key: 'ops', label: 'Ops' } }],
  ['upsertStaffUser', { payload: { email: 'new@example.com', roleKey: 'viewer', fullName: 'New' } }],
  ['deactivateStaffUser', { itemId: 'user-viewer' }],
  ['reactivateStaffUser', { itemId: 'user-viewer' }],
  ['inviteStaffUser', { payload: { email: 'new@example.com', roleKey: 'viewer' } }],
  ['setStaffPassword', { email: VIEWER, newPassword: 'a-new-password' }],
  ['resetStaffPassword', { email: VIEWER }],
  ['revokeStaffSessions', { email: VIEWER }],
];

describe('privilege gating', () => {
  test.each(MANAGE_STAFF_EXPORTS)('%s refuses an unauthenticated caller', async (name, args) => {
    install();
    await expect(staff[name]({ ...args })).rejects.toThrow('AUTH_REQUIRED');
  });

  test.each(MANAGE_STAFF_EXPORTS)('%s refuses a role without manageStaff', async (name, args) => {
    // The escalation case: an ordinary signed-in user must not be able to create
    // accounts, change roles, reset passwords or revoke sessions.
    install();
    const token = await tokenFor(VIEWER);
    await expect(staff[name]({ sessionToken: token, ...args })).rejects.toThrow('ACCESS_DENIED');
  });

  test('a viewer cannot create an admin account', async () => {
    install();
    const token = await tokenFor(VIEWER);
    await expect(staff.upsertStaffUser({
      sessionToken: token,
      payload: { email: 'backdoor@example.com', roleKey: 'admin', fullName: 'Backdoor' },
    })).rejects.toThrow('ACCESS_DENIED');
    expect(userRow('backdoor@example.com')).toBeUndefined();
  });

  test('a non-admin role granted manageStaff is allowed through', async () => {
    // Proves the gate keys off the permission, not merely off roleKey === admin.
    install(seed({
      StaffRoles: [
        { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true },
        { _id: 'role-ops', key: 'ops', label: 'Ops', active: true, specialPermissions: 'manageStaff|viewChangeHistory' },
      ],
      StaffUsers: [
        { _id: 'user-admin', email: ADMIN, fullName: 'Admin', roleKey: 'admin', active: true },
        { _id: 'user-ops', email: VIEWER, fullName: 'Ops', roleKey: 'ops', active: true },
      ],
    }));
    const token = await tokenFor(VIEWER);
    const saved = await staff.upsertStaffUser({
      sessionToken: token,
      payload: { email: 'new@example.com', roleKey: 'ops', fullName: 'New' },
    });
    expect(saved.email).toBe('new@example.com');
  });
});

describe('upsertStaffUser', () => {
  test('creates a user with a valid role', async () => {
    install();
    const saved = await staff.upsertStaffUser({
      sessionToken: await tokenFor(ADMIN),
      payload: { email: 'New@Example.com', roleKey: 'viewer', fullName: 'New Person' },
    });
    expect(saved.email).toBe('new@example.com'); // normalised
    expect(saved.roleKey).toBe('viewer');
  });

  test('refuses a role that does not exist', async () => {
    install();
    await expect(staff.upsertStaffUser({
      sessionToken: await tokenFor(ADMIN),
      payload: { email: 'new@example.com', roleKey: 'nonexistent', fullName: 'New' },
    })).rejects.toThrow();
  });

  test('refuses a role that has been deactivated', async () => {
    // An inactive role must not be assignable, or a user could be parked on a
    // role whose permissions nobody is maintaining.
    install(seed({
      StaffRoles: [
        { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true },
        { _id: 'role-old', key: 'old', label: 'Retired', active: false },
      ],
    }));
    await expect(staff.upsertStaffUser({
      sessionToken: await tokenFor(ADMIN),
      payload: { email: 'new@example.com', roleKey: 'old', fullName: 'New' },
    })).rejects.toThrow();
  });

  test('refuses a duplicate email', async () => {
    install();
    await expect(staff.upsertStaffUser({
      sessionToken: await tokenFor(ADMIN),
      payload: { email: VIEWER, roleKey: 'viewer', fullName: 'Duplicate' },
    })).rejects.toThrow(/υπάρχει|exists/i);
  });

  test('records the change in the audit log', async () => {
    install();
    await staff.upsertStaffUser({
      sessionToken: await tokenFor(ADMIN),
      payload: { email: 'new@example.com', roleKey: 'viewer', fullName: 'New' },
    });
    expect(fake.rows('StaffAuditLog').some((e) => e.action === 'user.create')).toBe(true);
  });
});

describe('deactivateStaffUser', () => {
  test('revokes the user\'s live sessions, not just future logins', async () => {
    // The property that matters when someone leaves: an existing session must
    // stop working immediately, otherwise they keep access until it expires.
    install();
    const viewerToken = await tokenFor(VIEWER);
    expect((await getSessionState({ sessionToken: viewerToken })).authenticated).toBe(true);

    await staff.deactivateStaffUser({ sessionToken: await tokenFor(ADMIN), itemId: 'user-viewer' });

    expect(userRow(VIEWER).active).toBe(false);
    expect(sessionsFor(VIEWER).every((s) => s.active === false)).toBe(true);
    expect((await getSessionState({ sessionToken: viewerToken })).authenticated).toBe(false);
  });

  test('prevents the deactivated user from signing back in', async () => {
    install();
    await staff.deactivateStaffUser({ sessionToken: await tokenFor(ADMIN), itemId: 'user-viewer' });
    await expect(loginStaff({ email: VIEWER, password: PASSWORD })).rejects.toThrow();
  });

  test('reactivation restores login', async () => {
    install();
    const adminToken = await tokenFor(ADMIN);
    await staff.deactivateStaffUser({ sessionToken: adminToken, itemId: 'user-viewer' });
    await staff.reactivateStaffUser({ sessionToken: adminToken, itemId: 'user-viewer' });

    expect(userRow(VIEWER).active).toBe(true);
    await expect(loginStaff({ email: VIEWER, password: PASSWORD })).resolves.toMatchObject({ success: true });
  });

  test('requires an itemId', async () => {
    install();
    await expect(staff.deactivateStaffUser({ sessionToken: await tokenFor(ADMIN) })).rejects.toThrow(/itemId/i);
  });
});

describe('changeOwnPassword', () => {
  test('requires the correct current password', async () => {
    install();
    await expect(staff.changeOwnPassword({
      sessionToken: await tokenFor(VIEWER),
      currentPassword: 'wrong-password',
      newPassword: 'a-brand-new-password',
    })).rejects.toThrow();
  });

  test('enforces a minimum length on the new password', async () => {
    install();
    await expect(staff.changeOwnPassword({
      sessionToken: await tokenFor(VIEWER),
      currentPassword: PASSWORD,
      newPassword: 'short',
    })).rejects.toThrow(/8/);
  });

  test('changes the password so the old one stops working', async () => {
    install();
    await staff.changeOwnPassword({
      sessionToken: await tokenFor(VIEWER),
      currentPassword: PASSWORD,
      newPassword: 'a-brand-new-password',
    });

    await expect(loginStaff({ email: VIEWER, password: PASSWORD })).rejects.toThrow();
    await expect(loginStaff({ email: VIEWER, password: 'a-brand-new-password' }))
      .resolves.toMatchObject({ success: true });
  });

  test('stores a new salt rather than reusing the old one', async () => {
    install();
    const before = fake.rows('StaffCredentials').find((c) => c.email === VIEWER).passwordSalt;
    await staff.changeOwnPassword({
      sessionToken: await tokenFor(VIEWER),
      currentPassword: PASSWORD,
      newPassword: 'a-brand-new-password',
    });
    const after = fake.rows('StaffCredentials').find((c) => c.email === VIEWER).passwordSalt;
    expect(after).not.toBe(before);
  });
});

describe('setStaffPassword', () => {
  test('lets an admin set another user\'s password', async () => {
    install();
    await staff.setStaffPassword({
      sessionToken: await tokenFor(ADMIN),
      email: VIEWER,
      newPassword: 'admin-set-password',
    });
    await expect(loginStaff({ email: VIEWER, password: 'admin-set-password' }))
      .resolves.toMatchObject({ success: true });
  });

  test('can force a password change on next login', async () => {
    install();
    await staff.setStaffPassword({
      sessionToken: await tokenFor(ADMIN),
      email: VIEWER,
      newPassword: 'admin-set-password',
      mustChangePassword: true,
    });
    const result = await loginStaff({ email: VIEWER, password: 'admin-set-password' });
    expect(result.profile.mustChangePassword).toBe(true);
  });

  test('enforces the minimum length and a known user', async () => {
    install();
    const token = await tokenFor(ADMIN);
    await expect(staff.setStaffPassword({ sessionToken: token, email: VIEWER, newPassword: 'short' })).rejects.toThrow(/8/);
    await expect(staff.setStaffPassword({ sessionToken: token, email: 'nobody@example.com', newPassword: 'long-enough-password' }))
      .rejects.toThrow(/not found/i);
  });
});

describe('revokeStaffSessions', () => {
  test('revokes every session for a user', async () => {
    install();
    await tokenFor(VIEWER);
    await tokenFor(VIEWER); // two devices
    expect(sessionsFor(VIEWER).filter((s) => s.active !== false)).toHaveLength(2);

    const result = await staff.revokeStaffSessions({ sessionToken: await tokenFor(ADMIN), email: VIEWER });

    expect(result.revoked).toBe(2); // the viewer's two; the admin's own is untouched
    expect(sessionsFor(VIEWER).every((s) => s.active === false)).toBe(true);
  });

  test('exceptCurrent keeps the calling session alive', async () => {
    // An admin revoking their own sessions must not lock themselves out mid-task.
    install();
    const adminToken = await tokenFor(ADMIN);
    await tokenFor(ADMIN); // a second admin session

    await staff.revokeStaffSessions({ sessionToken: adminToken, email: ADMIN, exceptCurrent: true });

    expect((await getSessionState({ sessionToken: adminToken })).authenticated).toBe(true);
    const active = sessionsFor(ADMIN).filter((s) => s.active !== false);
    expect(active).toHaveLength(1);
    expect(active[0].tokenHash).toBe(sha256(adminToken));
  });

  test('requires an email when no session id is given', async () => {
    install();
    await expect(staff.revokeStaffSessions({ sessionToken: await tokenFor(ADMIN) })).rejects.toThrow(/email/i);
  });
});
