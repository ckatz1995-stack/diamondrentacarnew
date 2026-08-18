import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_TYPES,
  normalizeBridgeMessage,
  buildBookingContext,
  postMessageSafe,
  resolveHtmlComponent,
  isTrustedBridgeOrigin,
  getBridgeTelemetrySnapshot,
  resetBridgeTelemetry,
} from '../bridgeUtils.js';

// The bridge between the Velo page and the booking UI embedded in an
// HtmlComponent. Everything the two sides say to each other goes through here,
// and nothing in src/public had a test.
//
// The part that matters most is isTrustedBridgeOrigin: it is the only thing
// deciding whether a postMessage event arriving at the page is acted on. Suffix
// matching against a domain allowlist is where this kind of check usually goes
// wrong, so the near-miss hosts are tested explicitly rather than assumed.
//
// The module keeps counters in module scope, so every test resets them.

beforeEach(() => {
  resetBridgeTelemetry();
});

describe('deciding whether an origin is trusted', () => {
  const TRUSTED = ['wix.com', 'wixsite.com', 'parastorage.com', 'wixstatic.com'];

  test.each(TRUSTED)('%s itself is trusted', (host) => {
    expect(isTrustedBridgeOrigin(`https://${host}`)).toBe(true);
  });

  test.each(TRUSTED)('a subdomain of %s is trusted', (host) => {
    expect(isTrustedBridgeOrigin(`https://editor.${host}`)).toBe(true);
    expect(isTrustedBridgeOrigin(`https://a.b.${host}`)).toBe(true);
  });

  test('a host that merely ends with the letters is NOT trusted', () => {
    // The classic suffix-matching hole. The check requires a dot before the
    // suffix, so these are rejected — which is the whole point of testing it.
    expect(isTrustedBridgeOrigin('https://notwix.com')).toBe(false);
    expect(isTrustedBridgeOrigin('https://evil-wix.com')).toBe(false);
    expect(isTrustedBridgeOrigin('https://mywixsite.com')).toBe(false);
    expect(isTrustedBridgeOrigin('https://fakeparastorage.com')).toBe(false);
  });

  test('a trusted name used as a prefix of someone else\'s domain is NOT trusted', () => {
    expect(isTrustedBridgeOrigin('https://wix.com.evil.example')).toBe(false);
    expect(isTrustedBridgeOrigin('https://wixsite.com.attacker.net')).toBe(false);
  });

  test('a trusted name buried in a path or query does not make an origin trusted', () => {
    expect(isTrustedBridgeOrigin('https://evil.example/wix.com')).toBe(false);
    expect(isTrustedBridgeOrigin('https://evil.example/?x=wixsite.com')).toBe(false);
  });

  test('an unrelated host is not trusted', () => {
    expect(isTrustedBridgeOrigin('https://example.com')).toBe(false);
    expect(isTrustedBridgeOrigin('https://localhost:3000')).toBe(false);
  });

  test('the check is case-insensitive on the host', () => {
    // Twice over, as it happens: `new URL()` already lower-cases the hostname,
    // so the explicit toLowerCase is belt-and-braces and removing it alone
    // changes nothing. The behaviour is what matters and it is pinned here.
    expect(isTrustedBridgeOrigin('https://EDITOR.WIX.COM')).toBe(true);
    expect(isTrustedBridgeOrigin('https://NOTWIX.COM')).toBe(false);
  });

  test('the scheme is not part of the decision', () => {
    // Only the hostname is compared, so an http origin on a trusted host passes.
    // Worth stating plainly rather than leaving to be discovered.
    expect(isTrustedBridgeOrigin('http://editor.wix.com')).toBe(true);
  });

  test('a malformed origin is rejected', () => {
    expect(isTrustedBridgeOrigin('not a url')).toBe(false);
    expect(isTrustedBridgeOrigin('://')).toBe(false);
  });

  test('an origin with no hostname is rejected', () => {
    // The early return for an empty hostname is defence in depth rather than
    // the thing doing the work: an empty host matches none of the trusted
    // suffixes either, so the answer is the same with or without it.
    expect(isTrustedBridgeOrigin('file:///etc/passwd')).toBe(false);
  });

  test('an empty origin is ACCEPTED, by design', () => {
    // A deliberate and documented weakening: Wix's HtmlComponent can emit
    // postMessage events without origin metadata, so the bridge accepts them and
    // leans on message-type validation at the page instead. Pinned loudly
    // because it is the one path where an untrusted sender could reach the page
    // if the page's own type check were ever relaxed.
    expect(isTrustedBridgeOrigin('')).toBe(true);
    expect(isTrustedBridgeOrigin('   ')).toBe(true);
    expect(isTrustedBridgeOrigin(null)).toBe(true);
    expect(isTrustedBridgeOrigin(undefined)).toBe(true);
  });

  test('an origin matching the current page host is trusted whatever the domain', () => {
    // A site served from its own custom domain still has to talk to itself.
    expect(isTrustedBridgeOrigin('https://diamond.example', 'https://diamond.example/booking')).toBe(true);
  });

  test('but a different host on a custom domain is not', () => {
    expect(isTrustedBridgeOrigin('https://evil.example', 'https://diamond.example/booking')).toBe(false);
  });

  test('a malformed current url falls back to the allowlist rather than failing open', () => {
    expect(isTrustedBridgeOrigin('https://editor.wix.com', 'not a url')).toBe(true);
    expect(isTrustedBridgeOrigin('https://evil.example', 'not a url')).toBe(false);
  });
});

describe('the telemetry the origin check keeps', () => {
  test('counts every check, and splits passes from drops', () => {
    isTrustedBridgeOrigin('https://editor.wix.com');
    isTrustedBridgeOrigin('https://evil.example');
    isTrustedBridgeOrigin('https://notwix.com');

    const snap = getBridgeTelemetrySnapshot();
    expect(snap.originChecks).toBe(3);
    expect(snap.trustedOriginPasses).toBe(1);
    expect(snap.untrustedOriginDrops).toBe(2);
  });

  test('reports the drop rate as a percentage', () => {
    isTrustedBridgeOrigin('https://editor.wix.com');
    isTrustedBridgeOrigin('https://evil.example');
    expect(getBridgeTelemetrySnapshot().rates.untrustedOriginPct).toBe(50);
  });

  test('a rate with no samples is zero, not NaN', () => {
    const snap = getBridgeTelemetrySnapshot();
    expect(snap.rates.untrustedOriginPct).toBe(0);
    expect(snap.rates.parseFailurePct).toBe(0);
    expect(snap.rates.postFailurePct).toBe(0);
  });

  test('an empty origin counts as a pass, not as an unchecked event', () => {
    isTrustedBridgeOrigin('');
    const snap = getBridgeTelemetrySnapshot();
    expect(snap.originChecks).toBe(1);
    expect(snap.trustedOriginPasses).toBe(1);
  });

  test('resetting clears the counters and the history', () => {
    isTrustedBridgeOrigin('https://evil.example');
    resetBridgeTelemetry();
    const snap = getBridgeTelemetrySnapshot();
    expect(snap.originChecks).toBe(0);
    expect(snap.historySize).toBe(0);
    expect(snap.lastEventAt).toBeNull();
    expect(snap.lastEventType).toBeNull();
  });

  test('the last event is reported by type and time', () => {
    isTrustedBridgeOrigin('https://evil.example');
    const snap = getBridgeTelemetrySnapshot();
    expect(snap.lastEventType).toBe('untrustedOriginDrops');
    expect(typeof snap.lastEventAt).toBe('number');
  });

  test('events older than the window are left out of the per-minute view', () => {
    jest.useFakeTimers({ now: new Date('2026-05-01T12:00:00.000Z') });
    try {
      isTrustedBridgeOrigin('https://evil.example');
      jest.setSystemTime(new Date('2026-05-01T12:02:00.000Z'));
      isTrustedBridgeOrigin('https://editor.wix.com');

      const snap = getBridgeTelemetrySnapshot();
      // Cumulative counters keep both; the windowed view keeps only the recent.
      expect(snap.originChecks).toBe(2);
      expect(snap.perMinute.originChecks).toBe(1);
      expect(snap.perMinute.trustedOriginPasses).toBe(1);
      expect(snap.perMinute.untrustedOriginDrops).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the windowed rate is computed from the window, not the total', () => {
    jest.useFakeTimers({ now: new Date('2026-05-01T12:00:00.000Z') });
    try {
      isTrustedBridgeOrigin('https://evil.example');
      jest.setSystemTime(new Date('2026-05-01T12:02:00.000Z'));
      isTrustedBridgeOrigin('https://evil.example');
      isTrustedBridgeOrigin('https://editor.wix.com');

      const snap = getBridgeTelemetrySnapshot();
      expect(snap.rates.untrustedOriginPct).toBe(66.67);
      expect(snap.windowRates.untrustedOriginPct).toBe(50);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the history is capped so a chatty page cannot grow it without bound', () => {
    for (let i = 0; i < 520; i += 1) isTrustedBridgeOrigin('https://evil.example');
    const snap = getBridgeTelemetrySnapshot();
    expect(snap.historySize).toBe(500);
    // The cumulative counter is not capped — only the history buffer is.
    expect(snap.originChecks).toBe(520);
  });

  test('the window length is reported alongside the numbers', () => {
    expect(getBridgeTelemetrySnapshot().historyWindowMs).toBe(60000);
  });
});

describe('normalising an inbound message', () => {
  test('a JSON string is parsed', () => {
    expect(normalizeBridgeMessage('{"type":"x","n":1}')).toEqual({ type: 'x', n: 1 });
  });

  test('an object is passed through untouched', () => {
    const raw = { type: 'x' };
    expect(normalizeBridgeMessage(raw)).toBe(raw);
  });

  test('unparseable JSON becomes null rather than throwing', () => {
    expect(normalizeBridgeMessage('{not json')).toBeNull();
  });

  test('a falsy message is null', () => {
    expect(normalizeBridgeMessage('')).toBeNull();
    expect(normalizeBridgeMessage(null)).toBeNull();
    expect(normalizeBridgeMessage(undefined)).toBeNull();
    expect(normalizeBridgeMessage(0)).toBeNull();
  });

  test('parse attempts, successes and failures are counted', () => {
    normalizeBridgeMessage('{"a":1}');
    normalizeBridgeMessage('{bad');
    normalizeBridgeMessage({ already: 'an object' });

    const snap = getBridgeTelemetrySnapshot();
    // Only strings are parse attempts; an object never was one.
    expect(snap.parseAttempts).toBe(2);
    expect(snap.parseSuccesses).toBe(1);
    expect(snap.parseFailures).toBe(1);
    expect(snap.rates.parseFailurePct).toBe(50);
  });
});

describe('building the context sent to the booking UI', () => {
  test('carries the protocol version and message type', () => {
    const ctx = buildBookingContext({ url: 'https://x.example/booking', query: {}, path: ['booking'] });
    expect(ctx.type).toBe(BRIDGE_TYPES.CONTEXT);
    expect(ctx.protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION);
    expect(ctx.url).toBe('https://x.example/booking');
    expect(ctx.path).toEqual(['booking']);
  });

  test('survives a missing location object', () => {
    const ctx = buildBookingContext(undefined);
    expect(ctx.type).toBe(BRIDGE_TYPES.CONTEXT);
    expect(ctx.query).toEqual({});
    expect(ctx.path).toEqual([]);
  });

  test('ordinary query parameters are passed through', () => {
    const ctx = buildBookingContext({ query: { category: 'ECO', days: '3' } });
    expect(ctx.query).toEqual({ category: 'ECO', days: '3' });
  });

  test('sensitive parameters are blanked, keeping the key', () => {
    // Blanked rather than dropped, so the receiving side still sees the shape.
    const ctx = buildBookingContext({ query: {
      token: 'abc', password: 'hunter2', sessionId: 'sid', authCode: 'x',
      secret: 's', email: 'a@b.c', phone: '+30 000',
    } });
    expect(ctx.query).toEqual({
      token: '', password: '', sessionId: '', authCode: '',
      secret: '', email: '', phone: '',
    });
  });

  test('the match is on a substring of the key, in any case', () => {
    const ctx = buildBookingContext({ query: {
      customerEmail: 'a@b.c', X_AUTH_TOKEN: 'x', userPassword: 'p',
    } });
    expect(ctx.query).toEqual({ customerEmail: '', X_AUTH_TOKEN: '', userPassword: '' });
  });

  test('which also blanks innocent keys that happen to contain those letters', () => {
    // `pass` matches `passengers`. Over-blanking is the safe direction here, but
    // it is real and worth knowing before someone wonders where the value went.
    const ctx = buildBookingContext({ query: { passengers: '4', authorCredit: 'x' } });
    expect(ctx.query).toEqual({ passengers: '', authorCredit: '' });
  });

  test('a query that is not an object is treated as empty', () => {
    expect(buildBookingContext({ query: 'category=ECO' }).query).toEqual({});
    expect(buildBookingContext({ query: null }).query).toEqual({});
  });
});

describe('posting a message to the component', () => {
  const component = (impl) => ({ postMessage: jest.fn(impl) });

  test('sends the payload and reports success', () => {
    const comp = component();
    expect(postMessageSafe(comp, { type: 'x' })).toBe(true);
    expect(comp.postMessage).toHaveBeenCalledWith({ type: 'x' });
  });

  test('refuses without a component, a payload, or a postMessage method', () => {
    expect(postMessageSafe(null, { type: 'x' })).toBe(false);
    expect(postMessageSafe(component(), null)).toBe(false);
    expect(postMessageSafe(component(), undefined)).toBe(false);
    expect(postMessageSafe({}, { type: 'x' })).toBe(false);
  });

  test('a refusal is not counted as an attempt', () => {
    postMessageSafe(null, { type: 'x' });
    expect(getBridgeTelemetrySnapshot().postAttempts).toBe(0);
  });

  test('a falsy but meaningful payload is still sent', () => {
    // Only null and undefined are refused; 0 and '' are legitimate payloads.
    const comp = component();
    expect(postMessageSafe(comp, 0)).toBe(true);
    expect(postMessageSafe(comp, '')).toBe(true);
  });

  test('a structured-clone failure is retried as JSON', () => {
    // The reason the fallback exists: HtmlComponent cannot always take an
    // object, and losing the message would strand the booking UI.
    let calls = 0;
    const comp = component((payload) => {
      calls += 1;
      if (typeof payload !== 'string') throw new Error('could not be cloned');
      return undefined;
    });

    expect(postMessageSafe(comp, { type: 'x' })).toBe(true);
    expect(calls).toBe(2);
    expect(comp.postMessage).toHaveBeenLastCalledWith('{"type":"x"}');

    const snap = getBridgeTelemetrySnapshot();
    expect(snap.postAttempts).toBe(1);
    expect(snap.postFallbacks).toBe(1);
    expect(snap.postSuccesses).toBe(1);
    expect(snap.postFailures).toBe(0);
  });

  test('a string payload is retried as itself, not double-encoded', () => {
    let calls = 0;
    const comp = component(() => {
      calls += 1;
      if (calls === 1) throw new Error('first attempt fails');
      return undefined;
    });

    expect(postMessageSafe(comp, 'already a string')).toBe(true);
    expect(comp.postMessage).toHaveBeenLastCalledWith('already a string');
  });

  test('a failure on both attempts is reported and counted', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const comp = component(() => { throw new Error('component is gone'); });
      expect(postMessageSafe(comp, { type: 'x' }, 'booking')).toBe(false);

      const snap = getBridgeTelemetrySnapshot();
      expect(snap.postFailures).toBe(1);
      expect(snap.postSuccesses).toBe(0);
      expect(snap.rates.postFailurePct).toBe(100);
      expect(spy).toHaveBeenCalledWith('[booking] postMessage failed', expect.any(Error));
    } finally {
      spy.mockRestore();
    }
  });

  test('the label names the caller in the log line', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const comp = component(() => { throw new Error('gone'); });
      postMessageSafe(comp, { type: 'x' });
      expect(spy).toHaveBeenCalledWith('[bridge] postMessage failed', expect.any(Error));
    } finally {
      spy.mockRestore();
    }
  });

  test('a payload that cannot be stringified fails rather than throwing', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const circular = {};
      circular.self = circular;
      const comp = component((payload) => {
        if (typeof payload !== 'string') throw new Error('could not be cloned');
      });
      expect(postMessageSafe(comp, circular)).toBe(false);
      expect(getBridgeTelemetrySnapshot().postFailures).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('finding the HtmlComponent to talk to', () => {
  test('returns the first candidate selector that resolves', () => {
    const first = { id: 'html1' };
    const $w = jest.fn((selector) => (selector === '#html2' ? first : null));
    expect(resolveHtmlComponent($w, ['#html1', '#html2'])).toBe(first);
  });

  test('skips a selector that throws', () => {
    const found = { id: 'html2' };
    const $w = jest.fn((selector) => {
      if (selector === '#html1') throw new Error('no such element');
      return found;
    });
    expect(resolveHtmlComponent($w, ['#html1', '#html2'])).toBe(found);
  });

  test('falls back to selecting by component type', () => {
    const byType = { id: 'first-of-type' };
    const $w = jest.fn((selector) => {
      if (selector !== 'HtmlComponent') return null;
      return { forEach: (fn) => { fn(byType); fn({ id: 'second' }); } };
    });
    expect(resolveHtmlComponent($w, ['#nope'])).toBe(byType);
  });

  test('returns null when nothing resolves at all', () => {
    const $w = jest.fn(() => null);
    expect(resolveHtmlComponent($w, ['#nope'])).toBeNull();
  });

  test('returns null when the type selection is empty', () => {
    const $w = jest.fn((selector) => (selector === 'HtmlComponent' ? { forEach: () => {} } : null));
    expect(resolveHtmlComponent($w, [])).toBeNull();
  });

  test('survives a $w that throws for everything', () => {
    const $w = jest.fn(() => { throw new Error('page not ready'); });
    expect(resolveHtmlComponent($w, ['#html1'])).toBeNull();
  });

  test('works with no candidate list at all', () => {
    const $w = jest.fn(() => null);
    expect(resolveHtmlComponent($w)).toBeNull();
  });
});
