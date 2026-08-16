import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
// Pure helpers only, used to build seed rows before a module instance exists.
// This binding is a different instance from the ones the tests load below, which
// does not matter: neither function touches module state or wix-data.
import { derivePasswordHash, randomHex } from '../staffAccess.jsw';

// The bootstrap login is a back door, and it is meant to be one: on a brand new
// deployment nobody has a password yet, so an admin can sign in once with a
// secret held outside the database and the system writes them a real credential
// on the way through.
//
// A back door is exactly the code that has to be pinned down. Every condition
// guarding it is a condition that, if it stops holding, hands a static shared
// secret a permanent way in. None of it was covered.
//
// Two things force the unusual shape of this file. getBootstrapPassword
// memoises its answer in a module-level promise, so the secret cannot be
// changed inside one module instance — each test loads its own copy of the
// module. And the password is read from process.env before the secrets vault,
// so the env var is the lever these tests pull.

const BOOTSTRAP_PASSWORD = 'first-run-secret-9f2a';
const ADMIN_EMAIL = 'admin@example.com';
const GENERIC_LOGIN_ERROR = 'Λάθος email ή password.';

function seed({ users = null, credentials = [] } = {}) {
  return {
    StaffRoles: [
      { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true, sortOrder: 1 },
      { _id: 'role-desk', key: 'desk', label: 'Desk', active: true, sortOrder: 2 },
    ],
    StaffUsers: users || [
      { _id: 'user-admin', email: ADMIN_EMAIL, fullName: 'First Admin', roleKey: 'admin', active: true },
    ],
    StaffCredentials: credentials,
    StaffSessions: [],
    StaffAuditLog: [],
  };
}

// A fresh module instance per test, so the memoised bootstrap password and the
// fake collections are built together and thrown away together.
async function boot({ bootstrapPassword = BOOTSTRAP_PASSWORD, secret = null, seedData = seed() } = {}) {
  jest.resetModules();

  if (bootstrapPassword === null) delete process.env.BACKROOM_BOOTSTRAP_PASSWORD;
  else process.env.BACKROOM_BOOTSTRAP_PASSWORD = bootstrapPassword;

  const wixData = (await import('wix-data')).default;
  const secrets = await import('wix-secrets-backend');
  const fake = createFakeWixData(seedData).install(wixData);

  // Only used when the env var is absent — that is the deployed arrangement,
  // where the password lives in the Wix secrets vault.
  const getSecret = jest.fn(async (name) => {
    if (secret === null) throw new Error('secret not found');
    if (name !== 'BACKROOM_BOOTSTRAP_PASSWORD') throw new Error(`unexpected secret ${name}`);
    return secret;
  });
  const originalGetSecret = secrets.getSecret;
  secrets.getSecret = getSecret;

  const staffAccess = await import('../staffAccess.jsw');

  return {
    staffAccess,
    fake,
    getSecret,
    cleanup() {
      fake.restore();
      secrets.getSecret = originalGetSecret;
    },
  };
}

let ctx = null;

async function start(options) {
  ctx = await boot(options);
  return ctx;
}

afterEach(() => {
  if (ctx) ctx.cleanup();
  ctx = null;
  delete process.env.BACKROOM_BOOTSTRAP_PASSWORD;
});

describe('the first login on an empty deployment', () => {
  test('an admin with no credential gets in with the bootstrap password', async () => {
    const { staffAccess } = await start();
    const result = await staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD });
    expect(result.success).toBe(true);
    expect(result.sessionToken).toEqual(expect.any(String));
    expect(result.profile).toMatchObject({ authenticated: true, email: ADMIN_EMAIL, isAdmin: true });
  });

  test('the way in is written down as a real credential', async () => {
    // Otherwise the secret stays the only way in, forever.
    const { staffAccess, fake } = await start();
    await staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD });

    const stored = fake.rows('StaffCredentials');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ email: ADMIN_EMAIL, active: true, mustChangePassword: true });
  });

  test('the bootstrap password is not stored in the clear', async () => {
    const { staffAccess, fake } = await start();
    await staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD });

    const [credential] = fake.rows('StaffCredentials');
    expect(credential.passwordHash).not.toContain(BOOTSTRAP_PASSWORD);
    expect(credential.passwordSalt).not.toContain(BOOTSTRAP_PASSWORD);
    expect(JSON.stringify(credential)).not.toContain(BOOTSTRAP_PASSWORD);
  });

  test('the new credential is the bootstrap password, so the next login is an ordinary one', async () => {
    const { staffAccess } = await start();
    await staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD });
    // Same password, but now it is checked against the stored hash rather than
    // against the secret.
    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD }))
      .resolves.toMatchObject({ success: true });
  });

  test('the first login forces a password change', async () => {
    const { staffAccess } = await start();
    const result = await staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD });
    expect(result.profile.mustChangePassword).toBe(true);
  });

  test('the result does not claim to say whether the back door was used', async () => {
    // There used to be a bootstrapUsed flag here that read false on exactly the
    // login it named, because the credential it tested had just been inserted
    // and so had an _id. Nothing consumed it, and a flag that is silently wrong
    // is worse than no flag: mustChangePassword above is what actually
    // distinguishes this login, and it is derived from the stored row.
    const { staffAccess } = await start();
    const result = await staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD });
    expect(result).not.toHaveProperty('bootstrapUsed');
    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'profile', 'sessionToken', 'success']);
  });

  test('the door closes behind it: a second admin cannot bootstrap afterwards', async () => {
    // This is what makes the back door a one-shot rather than a standing key.
    const seedData = seed({
      users: [
        { _id: 'user-admin', email: ADMIN_EMAIL, fullName: 'First Admin', roleKey: 'admin', active: true },
        { _id: 'user-admin-2', email: 'second@example.com', fullName: 'Second Admin', roleKey: 'admin', active: true },
      ],
    });
    const { staffAccess } = await start({ seedData });

    await staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD });
    await expect(staffAccess.loginStaff({ email: 'second@example.com', password: BOOTSTRAP_PASSWORD }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
  });
});

describe('who the back door refuses', () => {
  test('a non-admin, even with the right bootstrap password', async () => {
    // The role gate is the whole reason a desk user cannot use a secret that is
    // shared across a first-run deployment.
    const seedData = seed({
      users: [{ _id: 'user-desk', email: 'desk@example.com', fullName: 'Desk', roleKey: 'desk', active: true }],
    });
    const { staffAccess, fake } = await start({ seedData });

    await expect(staffAccess.loginStaff({ email: 'desk@example.com', password: BOOTSTRAP_PASSWORD }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
    expect(fake.rows('StaffCredentials')).toHaveLength(0);
  });

  test('an admin offering the wrong password', async () => {
    const { staffAccess, fake } = await start();
    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: 'not-the-secret' }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
    expect(fake.rows('StaffCredentials')).toHaveLength(0);
    expect(fake.rows('StaffSessions')).toHaveLength(0);
  });

  test('everyone, once any other account holds an active credential', async () => {
    // The count is taken across the whole collection, not per user: one desk
    // user with a password is enough to say this deployment has been set up.
    const seedData = seed({
      users: [
        { _id: 'user-admin', email: ADMIN_EMAIL, fullName: 'First Admin', roleKey: 'admin', active: true },
        { _id: 'user-desk', email: 'desk@example.com', fullName: 'Desk', roleKey: 'desk', active: true },
      ],
      credentials: [{
        _id: 'cred-desk',
        email: 'desk@example.com',
        passwordSalt: 'aa'.repeat(16),
        passwordHash: 'unused',
        active: true,
      }],
    });
    const { staffAccess } = await start({ seedData });

    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
  });

  test('everyone, when no bootstrap password is configured at all', async () => {
    // Neither the env var nor the vault has one. Nothing must match nothing.
    const { staffAccess } = await start({ bootstrapPassword: null, secret: null });
    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: 'anything' }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: ' ' }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
  });

  test('a deactivated admin, right password or not', async () => {
    const seedData = seed({
      users: [{ _id: 'user-admin', email: ADMIN_EMAIL, fullName: 'First Admin', roleKey: 'admin', active: false }],
    });
    const { staffAccess, fake } = await start({ seedData });

    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
    expect(fake.rows('StaffCredentials')).toHaveLength(0);
  });

  test('an admin whose role has been deactivated', async () => {
    const seedData = seed();
    seedData.StaffRoles[0].active = false;
    const { staffAccess, fake } = await start({ seedData });

    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
    expect(fake.rows('StaffCredentials')).toHaveLength(0);
  });

  test('an address that is not a staff user, whatever the password', async () => {
    const { staffAccess, fake } = await start();
    await expect(staffAccess.loginStaff({ email: 'stranger@example.com', password: BOOTSTRAP_PASSWORD }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
    expect(fake.rows('StaffCredentials')).toHaveLength(0);
  });

  test('a refusal is the same sentence whichever gate stopped it', async () => {
    // A different message for "no bootstrap password configured" than for
    // "wrong password" would tell an outsider whether the door exists.
    const attempts = [
      ['wrong password', { seedData: seed() }, 'not-the-secret'],
      ['not an admin', { seedData: seed({ users: [{ _id: 'u', email: 'desk@example.com', roleKey: 'desk', active: true }] }) }, BOOTSTRAP_PASSWORD],
      ['nothing configured', { bootstrapPassword: null, secret: null }, 'anything'],
    ];
    const messages = [];
    for (const [, options, password] of attempts) {
      const local = await boot(options);
      const email = options.seedData?.StaffUsers?.[0]?.email || ADMIN_EMAIL;
      try {
        await local.staffAccess.loginStaff({ email, password });
        messages.push('NO ERROR');
      } catch (err) {
        messages.push(String(err.message));
      } finally {
        local.cleanup();
      }
    }
    expect(new Set(messages)).toEqual(new Set([GENERIC_LOGIN_ERROR]));
  });
});

describe('what a refused attempt leaves behind', () => {
  test('a failed bootstrap is written to the audit log', async () => {
    const { staffAccess, fake } = await start();
    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: 'not-the-secret' })).rejects.toThrow();

    const audit = fake.rows('StaffAuditLog');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'loginFailed', actorEmail: ADMIN_EMAIL });
  });

  test('no session is created', async () => {
    const { staffAccess, fake } = await start();
    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: 'not-the-secret' })).rejects.toThrow();
    expect(fake.rows('StaffSessions')).toHaveLength(0);
  });

  test('the attempted password is not recorded anywhere', async () => {
    const attempted = 'guessed-secret-attempt';
    const { staffAccess, fake } = await start();
    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: attempted })).rejects.toThrow();

    const written = JSON.stringify([fake.rows('StaffAuditLog'), fake.rows('StaffCredentials'), fake.rows('StaffSessions')]);
    expect(written).not.toContain(attempted);
  });

  test('a failed attempt does not consume the one-shot', async () => {
    const { staffAccess } = await start();
    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: 'wrong' })).rejects.toThrow();
    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD }))
      .resolves.toMatchObject({ success: true });
  });
});

describe('where the bootstrap password comes from', () => {
  test('the secrets vault is used when no environment variable is set', async () => {
    const { staffAccess, getSecret } = await start({ bootstrapPassword: null, secret: 'vault-secret-1234' });
    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: 'vault-secret-1234' }))
      .resolves.toMatchObject({ success: true });
    expect(getSecret).toHaveBeenCalledWith('BACKROOM_BOOTSTRAP_PASSWORD');
  });

  test('the environment variable wins over the vault', async () => {
    const { staffAccess, getSecret } = await start({ bootstrapPassword: BOOTSTRAP_PASSWORD, secret: 'vault-secret-1234' });
    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: 'vault-secret-1234' }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
    expect(getSecret).not.toHaveBeenCalled();
  });

  test('a vault that has no such secret closes the door rather than opening it', async () => {
    // getSecret throwing is the ordinary case on a site that never configured
    // one. The catch must not turn that into a match.
    const { staffAccess } = await start({ bootstrapPassword: null, secret: null });
    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: '' }))
      .rejects.toThrow();
    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: 'undefined' }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
  });

  test('a failed vault read does not fall back to a guessable constant', async () => {
    // The catch around getSecret returns a value, and the whole security of the
    // fallback rests on which one. Anything derived from the code — the secret's
    // own name, the collection names, the module's constants — would be a
    // password an outsider could read off a public repository.
    const { staffAccess } = await start({ bootstrapPassword: null, secret: null });

    const guesses = [
      'BACKROOM_BOOTSTRAP_PASSWORD',
      'backroom_bootstrap_password',
      'StaffCredentials',
      'admin',
      'null',
      'undefined',
      '[object Promise]',
    ];
    for (const guess of guesses) {
      await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: guess }))
        .rejects.toThrow(GENERIC_LOGIN_ERROR);
    }
  });

  test('an empty password is turned away before the bootstrap check runs at all', async () => {
    // This is the layer that makes an unconfigured password safe: an empty
    // secret can only ever be matched by an empty submission, and a submission
    // never gets that far. The !!bootstrapPassword guard behind it is a second
    // line that nothing reaches — deliberate belt and braces on a back door.
    const { staffAccess, fake } = await start({ bootstrapPassword: null, secret: null });

    for (const password of ['', null, undefined]) {
      await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password }))
        .rejects.toThrow('Συμπλήρωσε email και password.');
    }
    // Refused early enough that it is not even recorded as a login attempt.
    expect(fake.rows('StaffAuditLog')).toHaveLength(0);
  });

  test('the vault is read once and the answer reused', async () => {
    // Deployment note as much as a test: the password is memoised for the life
    // of the module, so adding the secret to a running site does not open the
    // door until it reloads.
    const seedData = seed({
      users: [
        { _id: 'user-admin', email: ADMIN_EMAIL, fullName: 'First Admin', roleKey: 'admin', active: true },
        { _id: 'user-admin-2', email: 'second@example.com', fullName: 'Second Admin', roleKey: 'admin', active: true },
      ],
    });
    const { staffAccess, getSecret } = await start({ bootstrapPassword: null, secret: 'vault-secret-1234', seedData });

    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: 'wrong' })).rejects.toThrow();
    await expect(staffAccess.loginStaff({ email: 'second@example.com', password: 'wrong' })).rejects.toThrow();
    expect(getSecret).toHaveBeenCalledTimes(1);
  });
});

describe('the state of the deployment decides, not the account', () => {
  test('deactivating an admin\'s own credential locks them out rather than re-arming the door', async () => {
    // The credential is looked up before the count is taken, so a row that
    // exists — active or not — sends the login down the ordinary path and it
    // fails there. Suspending an account must not hand its holder the shared
    // secret instead.
    //
    // The stored hash is a real hash of the password being offered, so the only
    // thing standing between this login and a session is the active flag. With
    // a junk hash this test would pass whether or not that flag were checked.
    const salt = randomHex(16);
    const seedData = seed({
      credentials: [{
        _id: 'cred-admin',
        email: ADMIN_EMAIL,
        passwordSalt: salt,
        passwordHash: derivePasswordHash(BOOTSTRAP_PASSWORD, salt),
        active: false,
      }],
    });
    const { staffAccess } = await start({ seedData });

    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
  });

  test('deleting the last credential row does re-arm it', async () => {
    // The actual recovery route when the only password is lost: remove the row,
    // not deactivate it. Which is also the reason the secret has to stay secret
    // for the life of the site, not just its first day.
    const { staffAccess, fake } = await start();
    await staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD });
    const [credential] = fake.rows('StaffCredentials');

    await fake.remove('StaffCredentials', credential._id);

    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD }))
      .resolves.toMatchObject({ success: true });
  });

  test('another account\'s deactivated credential does not hold the door shut', async () => {
    // The count only counts active rows, so a suspended colleague leaves the
    // deployment looking unconfigured to an admin who has no row of their own.
    const seedData = seed({
      users: [
        { _id: 'user-admin', email: ADMIN_EMAIL, fullName: 'First Admin', roleKey: 'admin', active: true },
        { _id: 'user-desk', email: 'desk@example.com', fullName: 'Desk', roleKey: 'desk', active: true },
      ],
      credentials: [{
        _id: 'cred-desk',
        email: 'desk@example.com',
        passwordSalt: 'ee'.repeat(16),
        passwordHash: 'unused',
        active: false,
      }],
    });
    const { staffAccess } = await start({ seedData });

    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD }))
      .resolves.toMatchObject({ success: true });
  });

  test('reactivating that credential closes it again', async () => {
    const seedData = seed({
      credentials: [{
        _id: 'cred-other',
        email: 'someone@example.com',
        passwordSalt: 'cc'.repeat(16),
        passwordHash: 'unused',
        active: true,
      }],
    });
    const { staffAccess } = await start({ seedData });

    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
  });

  test('a credential row with no active flag counts as active', async () => {
    // readBool defaults to true here, so a row written without the field still
    // shuts the door. Failing the other way would re-open it on a schema change.
    const seedData = seed({
      credentials: [{
        _id: 'cred-legacy',
        email: 'legacy@example.com',
        passwordSalt: 'dd'.repeat(16),
        passwordHash: 'unused',
      }],
    });
    const { staffAccess } = await start({ seedData });

    await expect(staffAccess.loginStaff({ email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD }))
      .rejects.toThrow(GENERIC_LOGIN_ERROR);
  });
});
