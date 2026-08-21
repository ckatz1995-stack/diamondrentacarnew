import { installPageEnv } from '../../../test/helpers/fakePageEnv.js';

// The site-wide message listener. Unlike the other controllers this one binds to
// `window` rather than to an embedded component, so it hears every page on the
// site — and it carries its own copy of the trusted-origin logic, a fourth
// alongside the one in bridgeUtils.
//
// It acts on two message types, and one of them navigates to a path taken
// straight out of the message. The origin check is therefore the whole of the
// protection, which is why the near-miss hosts are tested rather than assumed.

let env;
let wixLocation;
let members;
let storage;

async function boot({ url = 'https://diamond.example/booking' } = {}) {
  jest.resetModules();
  wixLocation = (await import('wix-location')).default;
  members = await import('wix-members-frontend');
  storage = await import('wix-storage');

  storage.local.clear();
  storage.session.clear();
  wixLocation.url = url;
  wixLocation.to = jest.fn();
  members.authentication.logout = jest.fn(async () => {});

  env = installPageEnv({});
  await env.start(() => import('../masterPage.js'));
  return env;
}

const send = (data, origin) => env.emitWindowMessage({ origin, data });

afterEach(() => {
  if (env) env.restore();
  env = null;
});

describe('binding the listener', () => {
  test('one message listener is registered on the window', async () => {
    await boot();
    expect(env.windowListenerCount()).toBe(1);
  });

  test('a runtime with no window is left alone rather than throwing', async () => {
    // The guard exists because Velo runs page code in contexts without a DOM.
    jest.resetModules();
    wixLocation = (await import('wix-location')).default;
    wixLocation.url = 'https://diamond.example/booking';
    env = installPageEnv({});
    delete global.window;
    await expect(env.start(() => import('../masterPage.js'))).resolves.toBeUndefined();
  });
});

describe('which origins it listens to', () => {
  const TRUSTED = ['wix.com', 'wixsite.com', 'parastorage.com', 'wixstatic.com'];

  test.each(TRUSTED)('a subdomain of %s is trusted', async (host) => {
    await boot();
    await send({ type: 'wix-booking-nav', path: '/booking' }, `https://editor.${host}`);
    expect(wixLocation.to).toHaveBeenCalledWith('/booking');
  });

  test('a host that merely ends with the letters is rejected', async () => {
    await boot();
    for (const origin of ['https://notwix.com', 'https://evil-wix.com', 'https://mywixsite.com']) {
      await send({ type: 'wix-booking-nav', path: '/booking' }, origin);
    }
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('a trusted name used as a prefix of another domain is rejected', async () => {
    await boot();
    await send({ type: 'wix-booking-nav', path: '/booking' }, 'https://wix.com.evil.example');
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('the page\'s own host is trusted even on a custom domain', async () => {
    await boot({ url: 'https://diamond.example/booking' });
    await send({ type: 'wix-booking-nav', path: '/booking' }, 'https://diamond.example');
    expect(wixLocation.to).toHaveBeenCalledWith('/booking');
  });

  test('a different host on a custom domain is rejected', async () => {
    await boot({ url: 'https://diamond.example/booking' });
    await send({ type: 'wix-booking-nav', path: '/booking' }, 'https://other.example');
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('an empty origin is REJECTED here, unlike the component bridge', async () => {
    // Worth stating because it differs from bridgeUtils, which accepts a missing
    // origin so that HtmlComponent events without metadata still work. This
    // listener hears the whole window, so it takes the stricter line.
    await boot();
    for (const origin of ['', '   ', null, undefined]) {
      await send({ type: 'wix-booking-nav', path: '/booking' }, origin);
    }
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('a malformed origin is rejected', async () => {
    await boot();
    await send({ type: 'wix-booking-nav', path: '/booking' }, 'not a url');
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('an unparseable page url rejects everything rather than failing open', async () => {
    await boot({ url: 'not a url' });
    await send({ type: 'wix-booking-nav', path: '/booking' }, 'https://editor.wix.com');
    expect(wixLocation.to).not.toHaveBeenCalled();
  });
});

describe('the messages it acts on', () => {
  const TRUSTED = 'https://editor.wix.com';

  test('a navigation message follows its path', async () => {
    await boot();
    await send({ type: 'wix-booking-nav', path: '/booking/step-2' }, TRUSTED);
    expect(wixLocation.to).toHaveBeenCalledWith('/booking/step-2');
  });

  test('a navigation with no path does nothing', async () => {
    await boot();
    await send({ type: 'wix-booking-nav' }, TRUSTED);
    await send({ type: 'wix-booking-nav', path: '' }, TRUSTED);
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('the path is taken from the message as-is, trusted origin permitting', async () => {
    // No same-site check on the path itself: the origin allowlist is the whole
    // of the protection here. Since wixsite.com is on that list, any Wix-hosted
    // page that can reach this window can choose the destination.
    await boot();
    await send({ type: 'wix-booking-nav', path: 'https://evil.example/x' }, TRUSTED);
    expect(wixLocation.to).toHaveBeenCalledWith('https://evil.example/x');
  });

  test('a navigation that throws is logged rather than breaking the page', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await boot();
      wixLocation.to = jest.fn(() => { throw new Error('navigation blocked'); });
      await send({ type: 'wix-booking-nav', path: '/booking' }, TRUSTED);
      expect(spy).toHaveBeenCalledWith('Navigation message failed', expect.any(Error));
    } finally {
      spy.mockRestore();
    }
  });

  test('a backroom logout clears the token, ends the member session and leaves', async () => {
    await boot();
    storage.local.setItem('diamond.backroom.session', 'tok-1');

    await send({ type: 'backroomLogout' }, TRUSTED);

    expect(storage.local.getItem('diamond.backroom.session')).toBeNull();
    expect(members.authentication.logout).toHaveBeenCalled();
    expect(wixLocation.to).toHaveBeenCalledWith('/myroom-home');
  });

  test('the token is cleared even if the member logout fails', async () => {
    await boot();
    storage.local.setItem('diamond.backroom.session', 'tok-1');
    members.authentication.logout = jest.fn(async () => { throw new Error('member service down'); });

    await send({ type: 'backroomLogout' }, TRUSTED);

    expect(storage.local.getItem('diamond.backroom.session')).toBeNull();
    expect(wixLocation.to).toHaveBeenCalledWith('/myroom-home');
  });

  test('a message with no type is ignored', async () => {
    await boot();
    await send({ path: '/booking' }, TRUSTED);
    await send(null, TRUSTED);
    await send(undefined, TRUSTED);
    expect(wixLocation.to).not.toHaveBeenCalled();
  });

  test('an unrecognised type is ignored', async () => {
    await boot();
    await send({ type: 'somethingElse', path: '/booking' }, TRUSTED);
    expect(wixLocation.to).not.toHaveBeenCalled();
  });
});
