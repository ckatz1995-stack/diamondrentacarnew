import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import {
  loginStaff,
  getSessionState,
  upsertStaffRole,
  inviteStaffUser,
  resetStaffPassword,
  derivePasswordHash,
  randomHex,
} from '../staffAccess.jsw';

// Roles decide what everyone else can do, and the endpoints that issue passwords
// decide who gets in at all. Both are .jsw exports behind the manageStaff
// permission, and both were uncovered.
//
// Two things carry the weight here. A role edit must not quietly widen or narrow
// what a role can reach — the permissions are written as a full set every time,
// so a save decides every flag, not just the ones the operator touched. And the
// backoffice must not be able to lock itself out: an inactive admin role means
// no administrator can sign in to make it active again.

const ADMIN = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';

const ADMIN_ROLE = {
  _id: 'r-admin', key: 'admin', label: 'Admin', active: true, systemRole: true, sortOrder: 1,
  specialPermissions: 'manageStaff|cancelBooking',
};

function seed({ roles = [ADMIN_ROLE], users = [], credentials = [] } = {}) {
  const passwordSalt = randomHex(16);
  return {
    StaffRoles: roles,
    StaffUsers: [
      { _id: 'u-admin', email: ADMIN, fullName: 'The Admin', roleKey: 'admin', active: true },
      ...users,
    ],
    StaffCredentials: [
      { _id: 'c-admin', email: ADMIN, passwordSalt, passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true },
      ...credentials,
    ],
    StaffSessions: [],
    StaffAuditLog: [],
  };
}

let fake;
function install(s) {
  fake = createFakeWixData(seed(s)).install(wixData);
  return fake;
}

async function token() {
  const { sessionToken } = await loginStaff({ email: ADMIN, password: PASSWORD });
  return sessionToken;
}

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

const roleRow = (key) => fake.rows('StaffRoles').find((r) => r.key === key);

describe('creating a role', () => {
  test('stores it with the permissions that were asked for', async () => {
    install({});
    await upsertStaffRole({
      sessionToken: await token(),
      payload: { key: 'desk', label: 'Desk', bookingsView: true, bookingsEdit: true },
    });
    expect(roleRow('desk')).toMatchObject({ label: 'Desk', bookingsView: true, bookingsEdit: true, active: true });
  });

  test('every permission not asked for is off, not absent', async () => {
    // A missing flag and a false flag read the same to canAccessArea, but only
    // one of them survives a round trip through the admin screen.
    install({});
    await upsertStaffRole({ sessionToken: await token(), payload: { key: 'desk', label: 'Desk', bookingsView: true } });
    const saved = roleRow('desk');
    expect(saved.bookingsEdit).toBe(false);
    expect(saved.financialsView).toBe(false);
    expect(saved.rentalsDelete).toBe(false);
  });

  test('the key is slugged from the label when none is given', async () => {
    install({});
    await upsertStaffRole({ sessionToken: await token(), payload: { label: 'Night Desk' } });
    expect(fake.rows('StaffRoles').map((r) => r.key)).toContain('night_desk');
  });

  test('refuses a second role with the same key', async () => {
    install({});
    await upsertStaffRole({ sessionToken: await token(), payload: { key: 'desk', label: 'Desk' } });
    await expect(upsertStaffRole({ sessionToken: await token(), payload: { key: 'desk', label: 'Desk Again' } }))
      .rejects.toThrow(/Υπάρχει ήδη role/);
  });

  test('refuses a role with no key at all', async () => {
    install({});
    await expect(upsertStaffRole({ sessionToken: await token(), payload: { label: '' } }))
      .rejects.toThrow(/role key/);
  });

  test('special permissions are stored as a list', async () => {
    install({});
    await upsertStaffRole({
      sessionToken: await token(),
      payload: { key: 'desk', label: 'Desk', specialPermissions: ['cancelBooking', 'overridePricing'] },
    });
    expect(roleRow('desk').specialPermissions).toBe('cancelBooking|overridePricing');
  });

  test('refuses a caller without manageStaff', async () => {
    install({
      roles: [ADMIN_ROLE, { _id: 'r-desk', key: 'desk', label: 'Desk', active: true, bookingsView: true }],
      users: [{ _id: 'u-desk', email: 'desk@example.com', fullName: 'Desk', roleKey: 'desk', active: true }],
      credentials: [(() => {
        const passwordSalt = randomHex(16);
        return { _id: 'c-desk', email: 'desk@example.com', passwordSalt, passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true };
      })()],
    });
    const { sessionToken } = await loginStaff({ email: 'desk@example.com', password: PASSWORD });
    // ACCESS_DENIED rather than AUTH_REQUIRED, and the distinction is worth
    // keeping: this caller is signed in and simply may not do this.
    await expect(upsertStaffRole({ sessionToken, payload: { key: 'new', label: 'New' } })).rejects.toThrow('ACCESS_DENIED');
    expect(roleRow('new')).toBeUndefined();
  });

  test('refuses an unauthenticated caller', async () => {
    install({});
    await expect(upsertStaffRole({ payload: { key: 'new', label: 'New' } })).rejects.toThrow('AUTH_REQUIRED');
    await expect(upsertStaffRole({ sessionToken: 'made-up', payload: { key: 'new', label: 'New' } })).rejects.toThrow('AUTH_REQUIRED');
  });
});

describe('editing a role', () => {
  const withDesk = () => ({
    roles: [
      ADMIN_ROLE,
      { _id: 'r-desk', key: 'desk', label: 'Desk', active: true, bookingsView: true, bookingsEdit: true, rentalsView: true },
    ],
  });

  test('a save writes the whole permission set, not only what changed', async () => {
    // Pinned because it is the opposite of what "update the label" suggests:
    // normalizeRole writes every flag on every save, so a payload that omits a
    // permission turns it off. The admin screen sends every checkbox on the form,
    // which is why this is safe there — a caller hand-rolling a payload gets a
    // role stripped to nothing.
    install(withDesk());
    await upsertStaffRole({ sessionToken: await token(), payload: { _id: 'r-desk', key: 'desk', label: 'Front Desk' } });

    const saved = roleRow('desk');
    expect(saved.label).toBe('Front Desk');
    expect(saved.bookingsView).toBe(false);
    expect(saved.bookingsEdit).toBe(false);
  });

  test('a save carrying the full set keeps what it carries', async () => {
    install(withDesk());
    await upsertStaffRole({
      sessionToken: await token(),
      payload: { _id: 'r-desk', key: 'desk', label: 'Front Desk', bookingsView: true, bookingsEdit: true, rentalsView: true },
    });
    expect(roleRow('desk')).toMatchObject({ label: 'Front Desk', bookingsView: true, bookingsEdit: true, rentalsView: true });
  });

  test('taking a permission away takes it away from the people holding the role', async () => {
    // The assertion that matters: a role edit has to change what a signed-in
    // user can actually reach, not merely what the row says.
    const passwordSalt = randomHex(16);
    install({
      roles: [ADMIN_ROLE, { _id: 'r-desk', key: 'desk', label: 'Desk', active: true, bookingsView: true, bookingsEdit: true }],
      users: [{ _id: 'u-desk', email: 'desk@example.com', fullName: 'Desk', roleKey: 'desk', active: true }],
      credentials: [{ _id: 'c-desk', email: 'desk@example.com', passwordSalt, passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true }],
    });
    const desk = await loginStaff({ email: 'desk@example.com', password: PASSWORD });
    expect((await getSessionState({ sessionToken: desk.sessionToken })).permissions.bookingsEdit).toBe(true);

    await upsertStaffRole({
      sessionToken: await token(),
      payload: { _id: 'r-desk', key: 'desk', label: 'Desk', bookingsView: true },
    });

    const after = await getSessionState({ sessionToken: desk.sessionToken });
    expect(after.permissions.bookingsEdit).toBe(false);
    expect(after.permissions.bookingsView).toBe(true);
  });

  test('the systemRole flag is not cleared by a save that does not mention it', async () => {
    // It marks the built-in roles. normalizeRole defaults it to false, so an
    // edit to the label used to quietly demote a structural role to an ordinary
    // one.
    install(withDesk());
    await upsertStaffRole({ sessionToken: await token(), payload: { _id: 'r-admin', key: 'admin', label: 'Admin' } });
    expect(roleRow('admin').systemRole).toBe(true);
  });

  test('the flag can still be set deliberately', async () => {
    install(withDesk());
    await upsertStaffRole({ sessionToken: await token(), payload: { _id: 'r-desk', key: 'desk', label: 'Desk', systemRole: true } });
    expect(roleRow('desk').systemRole).toBe(true);
  });

  test('records the change in the audit log, with what it was before', async () => {
    install(withDesk());
    await upsertStaffRole({ sessionToken: await token(), payload: { _id: 'r-desk', key: 'desk', label: 'Front Desk' } });

    const entry = fake.rows('StaffAuditLog').find((e) => e.action === 'role.update');
    expect(entry).toMatchObject({ entityType: 'role', actorEmail: ADMIN });
    expect(entry.oldValue).toContain('Desk');
    expect(entry.newValue).toContain('Front Desk');
  });

  test('creating a role is audited as a creation, not an update', async () => {
    install({});
    await upsertStaffRole({ sessionToken: await token(), payload: { key: 'desk', label: 'Desk' } });
    expect(fake.rows('StaffAuditLog').some((e) => e.action === 'role.create')).toBe(true);
    expect(fake.rows('StaffAuditLog').some((e) => e.action === 'role.update')).toBe(false);
  });
});

describe('the backoffice cannot lock itself out', () => {
  test('the last active admin role cannot be deactivated', async () => {
    install({});
    await expect(upsertStaffRole({
      sessionToken: await token(),
      payload: { _id: 'r-admin', key: 'admin', label: 'Admin', active: false },
    })).rejects.toThrow(/απενεργοποιηθεί ο admin/);
  });

  test('and the role is left active, not half-written', async () => {
    install({});
    await upsertStaffRole({ sessionToken: await token(), payload: { _id: 'r-admin', key: 'admin', label: 'Admin', active: false } }).catch(() => {});
    expect(roleRow('admin').active).toBe(true);
  });

  test('so the administrator can still sign in afterwards', async () => {
    // The consequence the guard exists for. Before it, this login failed and
    // nothing in the application could put it right — loginStaff refuses an
    // inactive role, no other default role carries manageStaff, and the bootstrap
    // password stays shut while credentials exist.
    install({});
    await upsertStaffRole({ sessionToken: await token(), payload: { _id: 'r-admin', key: 'admin', label: 'Admin', active: false } }).catch(() => {});
    await expect(loginStaff({ email: ADMIN, password: PASSWORD })).resolves.toMatchObject({ success: true });
  });

  test('there cannot be a second admin role to fall back on', async () => {
    // Which is why the guard does not look for one. Keys are unique, so the
    // admin role is always the only admin role, and deactivating it is always
    // the last one going.
    install({});
    await expect(upsertStaffRole({ sessionToken: await token(), payload: { key: 'admin', label: 'Admin (new)' } }))
      .rejects.toThrow(/Υπάρχει ήδη role/);
  });

  test('an ordinary role can still be deactivated', async () => {
    install({ roles: [ADMIN_ROLE, { _id: 'r-desk', key: 'desk', label: 'Desk', active: true }] });
    await upsertStaffRole({ sessionToken: await token(), payload: { _id: 'r-desk', key: 'desk', label: 'Desk', active: false } });
    expect(roleRow('desk').active).toBe(false);
  });

  test('an already-inactive role can be saved without tripping the guard', async () => {
    install({ roles: [ADMIN_ROLE, { _id: 'r-old', key: 'old', label: 'Old', active: false }] });
    await upsertStaffRole({ sessionToken: await token(), payload: { _id: 'r-old', key: 'old', label: 'Older', active: false } });
    expect(roleRow('old').label).toBe('Older');
  });

  test('an admin role that is already inactive can still be edited', async () => {
    // The guard looks at the transition, not the end state. Firing on a role
    // that is already off would make it uneditable — including turning it back
    // on, which is the one thing someone in that hole needs to do.
    //
    // Driven by a manager who holds manageStaff, because with the admin role off
    // no administrator can sign in to run it. That is also what makes this
    // reachable at all.
    const passwordSalt = randomHex(16);
    install({
      roles: [
        { ...ADMIN_ROLE, active: false },
        { _id: 'r-mgr', key: 'manager', label: 'Manager', active: true, specialPermissions: 'manageStaff' },
      ],
      users: [{ _id: 'u-mgr', email: 'mgr@example.com', fullName: 'Manager', roleKey: 'manager', active: true }],
      credentials: [{ _id: 'c-mgr', email: 'mgr@example.com', passwordSalt, passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true }],
    });
    const { sessionToken } = await loginStaff({ email: 'mgr@example.com', password: PASSWORD });

    await upsertStaffRole({ sessionToken, payload: { _id: 'r-admin', key: 'admin', label: 'Admin renamed', active: false } });
    expect(roleRow('admin').label).toBe('Admin renamed');
  });

  test('and a manager can turn the admin role back on', async () => {
    // The recovery path, end to end: the administrator can sign in again.
    const passwordSalt = randomHex(16);
    install({
      roles: [
        { ...ADMIN_ROLE, active: false },
        { _id: 'r-mgr', key: 'manager', label: 'Manager', active: true, specialPermissions: 'manageStaff' },
      ],
      users: [{ _id: 'u-mgr', email: 'mgr@example.com', fullName: 'Manager', roleKey: 'manager', active: true }],
      credentials: [{ _id: 'c-mgr', email: 'mgr@example.com', passwordSalt, passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true }],
    });
    const { sessionToken } = await loginStaff({ email: 'mgr@example.com', password: PASSWORD });
    await expect(loginStaff({ email: ADMIN, password: PASSWORD })).rejects.toThrow();

    await upsertStaffRole({ sessionToken, payload: { _id: 'r-admin', key: 'admin', label: 'Admin', active: true } });

    await expect(loginStaff({ email: ADMIN, password: PASSWORD })).resolves.toMatchObject({ success: true });
  });

  test('reactivating a role is never blocked', async () => {
    install({ roles: [ADMIN_ROLE, { _id: 'r-old', key: 'old', label: 'Old', active: false }] });
    await upsertStaffRole({ sessionToken: await token(), payload: { _id: 'r-old', key: 'old', label: 'Old', active: true } });
    expect(roleRow('old').active).toBe(true);
  });
});

describe('inviting a staff user', () => {
  test('creates the user and issues a temporary password that works', async () => {
    install({ roles: [ADMIN_ROLE, { _id: 'r-desk', key: 'desk', label: 'Desk', active: true, bookingsView: true }] });
    const result = await inviteStaffUser({
      sessionToken: await token(),
      payload: { email: 'New.Person@Example.com', fullName: 'New Person', roleKey: 'desk' },
    });

    expect(result).toMatchObject({ success: true, mode: 'invite', email: 'new.person@example.com', roleKey: 'desk' });
    await expect(loginStaff({ email: 'new.person@example.com', password: result.tempPassword }))
      .resolves.toMatchObject({ success: true });
  });

  test('the temporary password must be changed on first use', async () => {
    install({ roles: [ADMIN_ROLE, { _id: 'r-desk', key: 'desk', label: 'Desk', active: true }] });
    const result = await inviteStaffUser({ sessionToken: await token(), payload: { email: 'new@example.com', roleKey: 'desk' } });
    const login = await loginStaff({ email: 'new@example.com', password: result.tempPassword });
    expect(login.profile.mustChangePassword).toBe(true);
  });

  test('the temporary password is not stored in the clear', async () => {
    install({ roles: [ADMIN_ROLE, { _id: 'r-desk', key: 'desk', label: 'Desk', active: true }] });
    const result = await inviteStaffUser({ sessionToken: await token(), payload: { email: 'new@example.com', roleKey: 'desk' } });
    const stored = JSON.stringify([fake.rows('StaffCredentials'), fake.rows('StaffAuditLog')]);
    expect(stored).not.toContain(result.tempPassword);
  });

  test('two invitations do not produce the same password', async () => {
    install({ roles: [ADMIN_ROLE, { _id: 'r-desk', key: 'desk', label: 'Desk', active: true }] });
    const a = await inviteStaffUser({ sessionToken: await token(), payload: { email: 'a@example.com', roleKey: 'desk' } });
    const b = await inviteStaffUser({ sessionToken: await token(), payload: { email: 'b@example.com', roleKey: 'desk' } });
    expect(a.tempPassword).not.toBe(b.tempPassword);
  });

  test('re-inviting an existing user replaces their password rather than adding a second account', async () => {
    const passwordSalt = randomHex(16);
    install({
      roles: [ADMIN_ROLE, { _id: 'r-desk', key: 'desk', label: 'Desk', active: true }],
      users: [{ _id: 'u-desk', email: 'desk@example.com', fullName: 'Desk', roleKey: 'desk', active: true }],
      credentials: [{ _id: 'c-desk', email: 'desk@example.com', passwordSalt, passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true }],
    });
    const result = await inviteStaffUser({ sessionToken: await token(), payload: { email: 'desk@example.com' } });

    expect(result.mode).toBe('reinvite');
    expect(fake.rows('StaffUsers').filter((u) => u.email === 'desk@example.com')).toHaveLength(1);
    await expect(loginStaff({ email: 'desk@example.com', password: PASSWORD })).rejects.toThrow();
    await expect(loginStaff({ email: 'desk@example.com', password: result.tempPassword })).resolves.toMatchObject({ success: true });
  });

  test('re-inviting signs the user out of everywhere they were signed in', async () => {
    // Re-issuing access to an account whose password may have leaked is
    // pointless if the old sessions keep working.
    const passwordSalt = randomHex(16);
    install({
      roles: [ADMIN_ROLE, { _id: 'r-desk', key: 'desk', label: 'Desk', active: true }],
      users: [{ _id: 'u-desk', email: 'desk@example.com', fullName: 'Desk', roleKey: 'desk', active: true }],
      credentials: [{ _id: 'c-desk', email: 'desk@example.com', passwordSalt, passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true }],
    });
    const desk = await loginStaff({ email: 'desk@example.com', password: PASSWORD });
    expect((await getSessionState({ sessionToken: desk.sessionToken })).authenticated).toBe(true);

    await inviteStaffUser({ sessionToken: await token(), payload: { email: 'desk@example.com' } });

    expect(await getSessionState({ sessionToken: desk.sessionToken })).toEqual({ authenticated: false });
  });

  test('the administrator doing the inviting stays signed in', async () => {
    install({ roles: [ADMIN_ROLE, { _id: 'r-desk', key: 'desk', label: 'Desk', active: true }] });
    const adminToken = await token();
    await inviteStaffUser({ sessionToken: adminToken, payload: { email: 'new@example.com', roleKey: 'desk' } });
    expect((await getSessionState({ sessionToken: adminToken })).authenticated).toBe(true);
  });

  test('defaults an unnamed invitee to viewer rather than to nothing', async () => {
    install({ roles: [ADMIN_ROLE, { _id: 'r-viewer', key: 'viewer', label: 'Viewer', active: true, bookingsView: true }] });
    const result = await inviteStaffUser({ sessionToken: await token(), payload: { email: 'new@example.com' } });
    expect(result.roleKey).toBe('viewer');
  });

  test('refuses a role that does not exist', async () => {
    install({});
    await expect(inviteStaffUser({ sessionToken: await token(), payload: { email: 'new@example.com', roleKey: 'wizard' } }))
      .rejects.toThrow('Role not found');
    expect(fake.rows('StaffUsers').some((u) => u.email === 'new@example.com')).toBe(false);
  });

  test('refuses an empty email', async () => {
    install({});
    await expect(inviteStaffUser({ sessionToken: await token(), payload: { email: '  ' } })).rejects.toThrow('Missing email');
  });

  test('refuses an unauthenticated caller, and writes nothing', async () => {
    install({ roles: [ADMIN_ROLE, { _id: 'r-desk', key: 'desk', label: 'Desk', active: true }] });
    await expect(inviteStaffUser({ payload: { email: 'new@example.com', roleKey: 'desk' } })).rejects.toThrow('AUTH_REQUIRED');
    expect(fake.rows('StaffUsers').some((u) => u.email === 'new@example.com')).toBe(false);
    expect(fake.rows('StaffCredentials').some((c) => c.email === 'new@example.com')).toBe(false);
  });

  // Note on the gate below: inviteStaffUser checks manageStaff and then calls
  // upsertStaffUser, which checks it again. Removing either check alone leaves
  // the other refusing, so this test cannot distinguish them — what it pins is
  // that the pair of them holds.
  test('refuses a signed-in caller who does not manage staff', async () => {
    // Inviting mints a working password for a new account. A desk user who could
    // do it could hand themselves a second account at any role they liked.
    const passwordSalt = randomHex(16);
    install({
      roles: [ADMIN_ROLE, { _id: 'r-desk', key: 'desk', label: 'Desk', active: true, bookingsView: true }],
      users: [{ _id: 'u-desk', email: 'desk@example.com', fullName: 'Desk', roleKey: 'desk', active: true }],
      credentials: [{ _id: 'c-desk', email: 'desk@example.com', passwordSalt, passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true }],
    });
    const { sessionToken } = await loginStaff({ email: 'desk@example.com', password: PASSWORD });

    await expect(inviteStaffUser({ sessionToken, payload: { email: 'new@example.com', roleKey: 'admin' } }))
      .rejects.toThrow('ACCESS_DENIED');
    expect(fake.rows('StaffUsers').some((u) => u.email === 'new@example.com')).toBe(false);
    expect(fake.rows('StaffCredentials').some((c) => c.email === 'new@example.com')).toBe(false);
  });

  test('refuses a signed-in caller who does not manage staff from resetting a password', async () => {
    const passwordSalt = randomHex(16);
    install({
      roles: [ADMIN_ROLE, { _id: 'r-desk', key: 'desk', label: 'Desk', active: true, bookingsView: true }],
      users: [{ _id: 'u-desk', email: 'desk@example.com', fullName: 'Desk', roleKey: 'desk', active: true }],
      credentials: [{ _id: 'c-desk', email: 'desk@example.com', passwordSalt, passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true }],
    });
    const { sessionToken } = await loginStaff({ email: 'desk@example.com', password: PASSWORD });

    await expect(resetStaffPassword({ sessionToken, email: ADMIN })).rejects.toThrow('ACCESS_DENIED');
    await expect(loginStaff({ email: ADMIN, password: PASSWORD })).resolves.toMatchObject({ success: true });
  });

  test('the invitation is recorded against the person who sent it', async () => {
    install({ roles: [ADMIN_ROLE, { _id: 'r-desk', key: 'desk', label: 'Desk', active: true }] });
    await inviteStaffUser({ sessionToken: await token(), payload: { email: 'new@example.com', roleKey: 'desk' } });
    const entry = fake.rows('StaffAuditLog').find((e) => e.action === 'user.invite');
    expect(entry).toMatchObject({ actorEmail: ADMIN, entityId: 'new@example.com' });
  });
});

describe('resetting a password', () => {
  function withDesk() {
    const passwordSalt = randomHex(16);
    return {
      roles: [ADMIN_ROLE, { _id: 'r-desk', key: 'desk', label: 'Desk', active: true }],
      users: [{ _id: 'u-desk', email: 'desk@example.com', fullName: 'Desk', roleKey: 'desk', active: true }],
      credentials: [{ _id: 'c-desk', email: 'desk@example.com', passwordSalt, passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true }],
    };
  }

  test('issues a temporary password that replaces the old one', async () => {
    install(withDesk());
    const result = await resetStaffPassword({ sessionToken: await token(), email: 'desk@example.com' });

    await expect(loginStaff({ email: 'desk@example.com', password: PASSWORD })).rejects.toThrow();
    await expect(loginStaff({ email: 'desk@example.com', password: result.tempPassword }))
      .resolves.toMatchObject({ success: true });
  });

  test('the new password must be changed on first use', async () => {
    install(withDesk());
    const result = await resetStaffPassword({ sessionToken: await token(), email: 'desk@example.com' });
    const login = await loginStaff({ email: 'desk@example.com', password: result.tempPassword });
    expect(login.profile.mustChangePassword).toBe(true);
  });

  test('signs the user out of their existing sessions', async () => {
    install(withDesk());
    const desk = await loginStaff({ email: 'desk@example.com', password: PASSWORD });
    await resetStaffPassword({ sessionToken: await token(), email: 'desk@example.com' });
    expect(await getSessionState({ sessionToken: desk.sessionToken })).toEqual({ authenticated: false });
  });

  test('leaves everyone else signed in', async () => {
    install(withDesk());
    const adminToken = await token();
    await resetStaffPassword({ sessionToken: adminToken, email: 'desk@example.com' });
    expect((await getSessionState({ sessionToken: adminToken })).authenticated).toBe(true);
  });

  test('the temporary password is not stored in the clear', async () => {
    install(withDesk());
    const result = await resetStaffPassword({ sessionToken: await token(), email: 'desk@example.com' });
    const stored = JSON.stringify([fake.rows('StaffCredentials'), fake.rows('StaffAuditLog')]);
    expect(stored).not.toContain(result.tempPassword);
  });

  test('refuses an address that is not a staff user', async () => {
    install(withDesk());
    await expect(resetStaffPassword({ sessionToken: await token(), email: 'stranger@example.com' })).rejects.toThrow();
  });

  test('refuses an unauthenticated caller, and changes nothing', async () => {
    install(withDesk());
    await expect(resetStaffPassword({ email: 'desk@example.com' })).rejects.toThrow('AUTH_REQUIRED');
    await expect(loginStaff({ email: 'desk@example.com', password: PASSWORD })).resolves.toMatchObject({ success: true });
  });

  test('the reset is recorded against the administrator who ran it', async () => {
    install(withDesk());
    await resetStaffPassword({ sessionToken: await token(), email: 'desk@example.com' });
    const entry = fake.rows('StaffAuditLog').find((e) => e.action === 'passwordReset');
    expect(entry).toMatchObject({ actorEmail: ADMIN });
  });
});
