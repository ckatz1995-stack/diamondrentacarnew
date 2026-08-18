import { createFakeWixData } from './fakeWixData.js';
import { installPageEnv, createComponent } from './fakePageEnv.js';

// Boots a Velo page controller for a test.
//
// The awkward part this hides is module identity. A controller keeps state at
// module scope, so each test needs a fresh copy — but jest.resetModules() also
// gives it a fresh `wix-location`, `wix-storage` and `wix-data`, and if the test
// imported those at the top of its own file it would be holding different
// objects than the controller is. Everything therefore has to be imported here,
// after the reset, and handed back.

/**
 * @param {object} options
 * @param {() => Promise<any>} options.importer   dynamic import of the controller
 * @param {Record<string, any>} [options.components] selector -> component
 * @param {object} [options.seed]        wix-data seed
 * @param {string} [options.signInAs]    staff email to sign in and store a token for
 * @param {string} [options.password]    that account's password
 * @param {object} [options.query]       wixLocation.query
 * @param {string} [options.url]         wixLocation.url
 * @param {string[]} [options.path]      wixLocation.path
 * @param {boolean} [options.fakeTimers] freeze the clock (default true)
 * @param {() => Promise<void>} [options.beforeStart] runs after the module
 *   registry is reset but before the controller is imported. Anything a test
 *   wants to stub on a backend module has to be done here: a module imported
 *   before this call belongs to the previous generation and the controller will
 *   never see it.
 */
export async function bootPageController({
  importer,
  components = {},
  seed = null,
  signInAs = null,
  password = '',
  query = {},
  url = 'https://diamond.example/site/page',
  path = ['page'],
  fakeTimers = true,
  beforeStart = null,
} = {}) {
  jest.resetModules();
  if (fakeTimers) jest.useFakeTimers({ now: new Date('2026-03-10T12:00:00.000Z') });

  const wixLocation = (await import('wix-location')).default;
  const wixData = (await import('wix-data')).default;
  const storage = await import('wix-storage');

  storage.local.clear();
  storage.session.clear();

  const fake = seed ? createFakeWixData(seed).install(wixData) : null;

  if (signInAs) {
    const { loginStaff } = await import('../../src/backend/staffAccess.jsw');
    const { storeSessionToken } = await import('../../src/public/backroomAuth.js');
    const { sessionToken } = await loginStaff({ email: signInAs, password });
    storeSessionToken(sessionToken, true);
  }

  wixLocation.query = query;
  wixLocation.url = url;
  wixLocation.path = path;
  wixLocation.to = jest.fn();

  if (beforeStart) await beforeStart();

  const env = installPageEnv(components);
  await env.start(importer);

  return {
    env,
    fake,
    wixLocation,
    wixData,
    storage,
    component: (selector) => components[selector],
    // Async on purpose. Draining the pending timers can start async work — a
    // deferred re-sync, say — whose continuation runs a microtask later. Tearing
    // `$w` down before that lands leaves the callback reaching for a global that
    // is no longer there, which surfaces as an unhandled ReferenceError long
    // after the test that caused it has passed.
    async teardown() {
      if (env) {
        if (fakeTimers) jest.runOnlyPendingTimers();
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
        env.restore();
      }
      if (fake) fake.restore();
      if (fakeTimers) jest.useRealTimers();
    },
  };
}

export { createComponent };

/** Staff seed rows for a single admin account, for pages behind the backroom guard. */
export function staffSeed(hash, hex, { email, password, roles = [], users = [], extraCreds = [] } = {}) {
  const passwordSalt = hex(16);
  return {
    StaffRoles: [{ _id: 'role-admin', key: 'admin', label: 'Administrator', active: true }, ...roles],
    StaffUsers: [{ _id: 'u-1', email, fullName: 'A Operator', roleKey: 'admin', active: true }, ...users],
    StaffCredentials: [
      { _id: 'cred-1', email, passwordSalt, passwordHash: hash(password, passwordSalt), active: true },
      ...extraCreds,
    ],
    StaffSessions: [],
    StaffAuditLog: [],
  };
}
