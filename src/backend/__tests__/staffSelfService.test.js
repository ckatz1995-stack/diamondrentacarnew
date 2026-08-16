import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import {
  loginStaff, getSessionState, derivePasswordHash, randomHex, sha256,
  changeOwnPassword, revokeOwnOtherSessions, requestAccessRecovery,
  cleanupSessions, scheduledSessionCleanup, getStaffAccessSnapshot,
} from '../staffAccess.jsw';

// What a staff member can do to their own account without an administrator, plus
// the two housekeeping jobs. staffAccessAuth covers logging in and staffAdmin
// covers what an administrator does to other people; this is the gap between.
//
// The recovery endpoint is the only one here reachable before authenticating, so
// it is held to a different standard: its answer must not reveal whether an
// account exists.

const ME = 'me@example.com';
const OTHER = 'other@example.com';
const PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'a-brand-new-secret';

function credential(email, password = PASSWORD, extra = {}) {
  const passwordSalt = randomHex(16);
  return {
    _id: `cred-${email}`, email, passwordSalt,
    passwordHash: derivePasswordHash(password, passwordSalt), active: true, ...extra,
  };
}

function seed(extra = {}) {
  return {
    StaffRoles: [
      { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true },
      { _id: 'role-viewer', key: 'viewer', label: 'Viewer', active: true, bookingsView: true, specialPermissions: '' },
    ],
    StaffUsers: [
      { _id: 'user-me', email: ME, fullName: 'Me', roleKey: 'viewer', active: true },
      { _id: 'user-other', email: OTHER, fullName: 'Other', roleKey: 'admin', active: true },
    ],
    StaffCredentials: [credential(ME), credential(OTHER)],
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
async function token(email = ME, password = PASSWORD) {
  const { sessionToken } = await loginStaff({ email, password });
  return sessionToken;
}
const auditFor = (action) => fake.rows('StaffAuditLog').filter((a) => a.action === action);

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('changing your own password', () => {
  test('the current password has to be right', async () => {
    // Without this, anyone holding a session token — a borrowed laptop, a
    // stolen cookie — could lock the real owner out of their account.
    install();
    await expect(changeOwnPassword({
      sessionToken: await token(), currentPassword: 'not-my-password', newPassword: NEW_PASSWORD,
    })).rejects.toThrow(/τρέχον password/);
  });

  test('a wrong attempt leaves the old password working', async () => {
    install();
    await changeOwnPassword({
      sessionToken: await token(), currentPassword: 'wrong', newPassword: NEW_PASSWORD,
    }).catch(() => {});
    await expect(loginStaff({ email: ME, password: PASSWORD })).resolves.toMatchObject({ success: true });
  });

  test('the new password has to be long enough', async () => {
    install();
    await expect(changeOwnPassword({
      sessionToken: await token(), currentPassword: PASSWORD, newPassword: 'short',
    })).rejects.toThrow(/8 χαρακτήρες/);
  });

  test('a too-short attempt does not change anything', async () => {
    install();
    await changeOwnPassword({
      sessionToken: await token(), currentPassword: PASSWORD, newPassword: 'short',
    }).catch(() => {});
    await expect(loginStaff({ email: ME, password: PASSWORD })).resolves.toMatchObject({ success: true });
  });

  test('a successful change swaps which password works', async () => {
    install();
    await changeOwnPassword({ sessionToken: await token(), currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    await expect(loginStaff({ email: ME, password: NEW_PASSWORD })).resolves.toMatchObject({ success: true });
    // A rejected login throws rather than returning success:false.
    await expect(loginStaff({ email: ME, password: PASSWORD })).rejects.toThrow();
  });

  test('the stored hash changes, and the password is never stored in the clear', async () => {
    install();
    const before = fake.rows('StaffCredentials').find((c) => c.email === ME);
    await changeOwnPassword({ sessionToken: await token(), currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    const after = fake.rows('StaffCredentials').find((c) => c.email === ME);

    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(JSON.stringify(after)).not.toContain(NEW_PASSWORD);
  });

  test('changing a password clears the must-change flag', async () => {
    // Set when an administrator issues a temporary password. Left set, the user
    // would be asked to change it again on every login.
    install(seed({ StaffCredentials: [credential(ME, PASSWORD, { mustChangePassword: true }), credential(OTHER)] }));
    await changeOwnPassword({ sessionToken: await token(), currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(fake.rows('StaffCredentials').find((c) => c.email === ME).mustChangePassword).toBe(false);
  });

  test('it cannot be done without a session', async () => {
    install();
    await expect(changeOwnPassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }))
      .rejects.toThrow('AUTH_REQUIRED');
  });

  test('a change is recorded against the person who made it', async () => {
    install();
    await changeOwnPassword({ sessionToken: await token(), currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    const entry = auditFor('passwordChange').at(-1);
    expect(entry).toBeDefined();
    expect(entry.actorEmail).toBe(ME);
  });

  test('it only ever changes your own password, whoever else is signed in', async () => {
    install();
    const mine = await token(ME);
    await token(OTHER);
    await changeOwnPassword({ sessionToken: mine, currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    await expect(loginStaff({ email: OTHER, password: PASSWORD })).resolves.toMatchObject({ success: true });
  });
});

describe('revoking your own other sessions', () => {
  test('the session doing the revoking survives', async () => {
    // Otherwise signing out your other devices signs you out too, and the
    // obvious next move is to sign in again and repeat it.
    install();
    const mine = await token(ME);
    await token(ME);
    await token(ME);

    const result = await revokeOwnOtherSessions({ sessionToken: mine });
    expect(result.revoked).toBe(2);
    await expect(getSessionState({ sessionToken: mine })).resolves.toMatchObject({ authenticated: true });
  });

  test('the other sessions stop working', async () => {
    install();
    const first = await token(ME);
    const second = await token(ME);
    await revokeOwnOtherSessions({ sessionToken: second });
    await expect(getSessionState({ sessionToken: first })).resolves.toMatchObject({ authenticated: false });
  });

  test('nobody else is signed out', async () => {
    install();
    const mine = await token(ME);
    const theirs = await token(OTHER);
    await revokeOwnOtherSessions({ sessionToken: mine });
    await expect(getSessionState({ sessionToken: theirs })).resolves.toMatchObject({ authenticated: true });
  });

  test('revoking with only one session open reports nothing revoked', async () => {
    install();
    const result = await revokeOwnOtherSessions({ sessionToken: await token() });
    expect(result).toMatchObject({ success: true, revoked: 0 });
  });

  test('it cannot be done without a session', async () => {
    install();
    await expect(revokeOwnOtherSessions({})).rejects.toThrow('AUTH_REQUIRED');
  });
});

describe('access recovery', () => {
  // Reachable before signing in, so the answer must be the same whether or not
  // the account exists — otherwise the endpoint is an account-enumeration oracle
  // for anyone who wants to know who works here.
  const request = (email) => requestAccessRecovery({ email, userAgent: 'jest' });

  test('an unknown address gets the same answer as a real one', async () => {
    install();
    const real = await request(ME);
    const unknown = await request('nobody@example.com');
    expect(unknown.message).toBe(real.message);
    expect(unknown.accepted).toBe(real.accepted);
  });

  test('a deactivated account gets the same answer as an active one', async () => {
    install(seed({
      StaffUsers: [
        { _id: 'user-me', email: ME, fullName: 'Me', roleKey: 'viewer', active: true },
        { _id: 'user-gone', email: OTHER, fullName: 'Gone', roleKey: 'viewer', active: false },
      ],
    }));
    const active = await request(ME);
    const inactive = await request(OTHER);
    expect(inactive).toEqual(active);
  });

  test('no request is recorded for an address that is not a staff account', async () => {
    // The reply is identical either way; what differs is that nothing is
    // queued for an administrator to act on.
    install();
    await request('nobody@example.com');
    expect(auditFor('requestRecovery')).toHaveLength(0);
  });

  test('a request for a real account is queued for an administrator', async () => {
    install();
    await request(ME);
    const entry = auditFor('requestRecovery').at(-1);
    expect(entry).toBeDefined();
    expect(entry.entityId).toBe(ME);
    expect(entry.entityType).toBe('accessRecovery');
  });

  test('an empty address is refused outright', async () => {
    install();
    const result = await request('');
    expect(result.accepted).toBe(false);
  });

  test('the address is matched regardless of case or padding', async () => {
    install();
    await request(`  ${ME.toUpperCase()}  `);
    expect(auditFor('requestRecovery').at(-1).entityId).toBe(ME);
  });

  test('no credential material is handed back', async () => {
    // The endpoint queues a request for a human; it must not be a way to get
    // credentials without one. Asserted against the stored secrets rather than
    // against the word "password", which appears legitimately in the Greek
    // message telling the user an administrator will issue a temporary one.
    install();
    const stored = fake.rows('StaffCredentials').find((c) => c.email === ME);
    const body = JSON.stringify(await request(ME));

    expect(body).not.toContain(stored.passwordHash);
    expect(body).not.toContain(stored.passwordSalt);
    expect(Object.keys(await request(ME)).sort()).toEqual(['accepted', 'message', 'success']);
  });

  test('a second request in quick succession is turned away', async () => {
    install();
    await request(ME);
    const second = await request(ME);
    expect(second.accepted).toBe(false);
    expect(auditFor('requestRecovery')).toHaveLength(1);
  });

  test('KNOWN DEFECT: the repeat window is an hour rather than the 15 minutes asked for', async () => {
    // hasRecentRecoveryRequest asks addHours for -(15/60) of an hour, but
    // addHours goes through Date#setHours, which truncates its argument. The
    // fractional hour is lost and the lookback lands exactly one hour earlier.
    // Stricter than intended rather than looser, so it is pinned rather than
    // treated as urgent — but it is not the documented behaviour.
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-03-10T12:00:00Z'));
      install();
      await request(ME);

      // 20 minutes later: past the intended 15-minute window, still inside the
      // hour the code actually applies.
      jest.setSystemTime(new Date('2026-03-10T12:20:00Z'));
      expect((await request(ME)).accepted).toBe(false);

      // Just over an hour after the first request, it is allowed again.
      jest.setSystemTime(new Date('2026-03-10T13:05:00Z'));
      expect((await request(ME)).accepted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('KNOWN DEFECT: between midnight and 1am the repeat check does not apply at all', async () => {
    // The same truncation, at the one hour where it bites hardest. Date#setHours
    // truncates toward zero, so at hour 0 the negative fraction rounds to 0, the
    // lookback becomes "now", and the query for earlier requests matches
    // nothing. For that hour the endpoint can be called repeatedly, and each
    // call queues another administrator task.
    jest.useFakeTimers();
    try {
      // The clock has to advance between requests. Frozen, the stored timestamp
      // and the computed lookback are the same instant and the `>=` comparison
      // matches — which hides the defect rather than showing it.
      jest.setSystemTime(new Date('2026-03-10T00:10:00'));
      install();
      expect((await request(ME)).accepted).toBe(true);

      jest.setSystemTime(new Date('2026-03-10T00:20:00'));
      expect((await request(ME)).accepted).toBe(true);

      jest.setSystemTime(new Date('2026-03-10T00:40:00'));
      expect((await request(ME)).accepted).toBe(true);
      expect(auditFor('requestRecovery')).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('session cleanup', () => {
  function expiredSeed() {
    const past = new Date('2020-01-01T00:00:00Z');
    const future = new Date('2099-01-01T00:00:00Z');
    return seed({
      StaffSessions: [
        { _id: 's-expired', email: ME, tokenHash: sha256('a'), active: true, expiresAt: past },
        { _id: 's-revoked', email: ME, tokenHash: sha256('b'), active: false, expiresAt: future },
        { _id: 's-live', email: ME, tokenHash: sha256('c'), active: true, expiresAt: future },
      ],
    });
  }

  test('the scheduled job clears expired and revoked sessions but keeps live ones', async () => {
    install(expiredSeed());
    const result = await scheduledSessionCleanup();
    expect(result.deleted).toBe(2);
    expect(fake.rows('StaffSessions').map((s) => s._id)).toEqual(['s-live']);
  });

  test('the scheduled job needs no session of its own', async () => {
    // It runs from a Velo job, where there is no caller to authenticate.
    install(expiredSeed());
    await expect(scheduledSessionCleanup()).resolves.toMatchObject({ deleted: 2 });
  });

  test('the scheduled job is quiet when there is nothing to clear', async () => {
    install();
    await expect(scheduledSessionCleanup()).resolves.toMatchObject({ deleted: 0 });
  });

  test('the manual cleanup requires the staff-management permission', async () => {
    install(expiredSeed());
    await expect(cleanupSessions({ sessionToken: await token(ME) })).rejects.toThrow('ACCESS_DENIED');
    expect(fake.rows('StaffSessions').length).toBeGreaterThan(1);
  });

  test('an administrator may run the cleanup', async () => {
    install(expiredSeed());
    const result = await cleanupSessions({ sessionToken: await token(OTHER) });
    expect(result.success).toBe(true);
    expect(result.deleted).toBeGreaterThan(0);
  });

  test('the manual cleanup refuses an unauthenticated caller', async () => {
    install(expiredSeed());
    await expect(cleanupSessions({})).rejects.toThrow('AUTH_REQUIRED');
  });

  test('cleanup does not sign out the person running it', async () => {
    install(expiredSeed());
    const admin = await token(OTHER);
    await cleanupSessions({ sessionToken: admin });
    await expect(getSessionState({ sessionToken: admin })).resolves.toMatchObject({ authenticated: true });
  });
});

describe('the access snapshot', () => {
  test('an unauthenticated caller is told to authenticate and shown nothing', async () => {
    // The snapshot carries the staff list, the audit trail and every open
    // session. An empty-but-successful shape here would be a directory of who
    // works here, handed to anyone who asks.
    install();
    const snapshot = await getStaffAccessSnapshot({});
    expect(snapshot.accessState).toBe('authRequired');
    expect(snapshot.users).toEqual([]);
    expect(snapshot.auditRows).toEqual([]);
    expect(snapshot.sessionRows).toEqual([]);
    expect(snapshot.currentStaff).toBeNull();
  });

  test('a bogus token is treated the same as none', async () => {
    install();
    await expect(getStaffAccessSnapshot({ sessionToken: 'made-up' }))
      .resolves.toMatchObject({ accessState: 'authRequired', currentStaff: null });
  });

  test('an authenticated caller is identified back to themselves', async () => {
    install();
    const snapshot = await getStaffAccessSnapshot({ sessionToken: await token(OTHER) });
    expect(snapshot.accessState).not.toBe('authRequired');
    expect(snapshot.currentStaff?.email).toBe(OTHER);
  });
});
