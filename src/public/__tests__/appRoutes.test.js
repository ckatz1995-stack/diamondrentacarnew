import { APP_ROUTES } from '../appRoutes.js';

// A constants map, so these pin the invariants the routes have to satisfy rather
// than restating the values. backroomAuth builds redirect targets by appending a
// query string to one of these, which is why the shape matters.

describe('the backroom route map', () => {
  const entries = Object.entries(APP_ROUTES);

  test('every route is a root-relative path', () => {
    // requireBackroomAccess appends `?next=...` to one of these. A bare or
    // absolute value would send an operator off-site or to a broken URL.
    for (const [name, path] of entries) {
      expect(typeof path).toBe('string');
      expect(path.startsWith('/')).toBe(true);
      expect(path.startsWith('//')).toBe(false);
      expect(name && path).toBeTruthy();
    }
  });

  test('no route carries a query string or fragment of its own', () => {
    for (const [, path] of entries) {
      expect(path).not.toContain('?');
      expect(path).not.toContain('#');
    }
  });

  test('the login route is distinct from every signed-in destination', () => {
    // The guard redirects to a signed-in page by default; if login collided with
    // one of them a signed-out visitor would be bounced in a loop.
    const others = entries.filter(([name]) => name !== 'login').map(([, path]) => path);
    expect(others).not.toContain(APP_ROUTES.login);
  });

  test('pricing deliberately shares the settings screen', () => {
    // The one intentional alias — pricing is a section of account settings, not
    // a page of its own. Stated so a future split is a deliberate change.
    expect(APP_ROUTES.pricing).toBe(APP_ROUTES.settings);
  });

  test('every other route is unique', () => {
    const paths = entries.filter(([name]) => name !== 'pricing').map(([, path]) => path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
