import { getCrypto, sha256, randomHex, safeEqual, fallbackHash } from '../cryptoUtils.js';

// The shared crypto primitives. Every path through this file was reachable in
// production and only the crypto-backed half had tests — the fallbacks, which
// run when the runtime exposes no crypto module, were entirely unexercised.
// They are the code that decides whether a session token is stored safely, so
// "probably fine" is not good enough for them.
//
// The no-crypto tests load a fresh copy of the module with `crypto` stubbed,
// because getCrypto memoizes its answer for the life of the module.

/** A fresh module instance whose `require('crypto')` yields `factory()`. */
function loadWith(factory) {
  let mod;
  jest.isolateModules(() => {
    jest.doMock('crypto', factory);
    // eslint-disable-next-line global-require
    mod = require('../cryptoUtils.js');
  });
  return mod;
}
const withoutCryptoModule = () => loadWith(() => { throw new Error('crypto unavailable'); });
const withEmptyCryptoModule = () => loadWith(() => ({}));

const HEX_64 = /^[0-9a-f]{64}$/;

afterEach(() => {
  jest.dontMock('crypto');
  jest.resetModules();
});

describe('getCrypto', () => {
  test('finds the runtime crypto module', () => {
    expect(getCrypto()).toBeTruthy();
    expect(typeof getCrypto().createHash).toBe('function');
  });

  test('answers the same object every time', () => {
    // Memoized, including the negative answer — so a runtime without crypto
    // does not retry a failing require on every hash.
    expect(getCrypto()).toBe(getCrypto());
  });

  test('returns null rather than throwing when there is no crypto module', () => {
    expect(withoutCryptoModule().getCrypto()).toBeNull();
  });
});

describe('sha256', () => {
  test('matches the known digest of a known input', () => {
    // The empty-string digest, so the test is checking SHA-256 itself rather
    // than agreeing with whatever the implementation happens to produce.
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('matches the known digest of "abc"', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('is deterministic', () => {
    expect(sha256('token-value')).toBe(sha256('token-value'));
  });

  test('a one-character change changes the digest', () => {
    expect(sha256('token-value')).not.toBe(sha256('token-valuf'));
  });

  test.each([
    ['null', null], ['undefined', undefined], ['a number', 42], ['an empty string', ''],
  ])('coerces %s without throwing', (_label, value) => {
    expect(sha256(value)).toMatch(HEX_64);
  });

  test('falls back to a 64-character digest when there is no crypto module', () => {
    const mod = withoutCryptoModule();
    expect(mod.sha256('token-value')).toMatch(HEX_64);
  });

  test('falls back when the crypto module lacks createHash', () => {
    const mod = withEmptyCryptoModule();
    expect(mod.sha256('token-value')).toMatch(HEX_64);
  });

  test('the fallback is still deterministic and still input-sensitive', () => {
    // Weaker than SHA-256 by design, but useless if it is not a function of
    // its input.
    const mod = withoutCryptoModule();
    expect(mod.sha256('a')).toBe(mod.sha256('a'));
    expect(mod.sha256('a')).not.toBe(mod.sha256('b'));
  });
});

describe('fallbackHash', () => {
  test('produces a 64-character hex string, matching sha256 in shape', () => {
    // Callers store the result in the same field either way, so the shape has
    // to agree even though the strength does not.
    expect(fallbackHash('anything')).toMatch(HEX_64);
    expect(fallbackHash('')).toMatch(HEX_64);
  });

  test('is deterministic', () => {
    expect(fallbackHash('token-value')).toBe(fallbackHash('token-value'));
  });

  test.each([
    ['a one-character change', 'token-value', 'token-valuf'],
    ['a transposition', 'ab', 'ba'],
    ['a prefix', 'token', 'token-value'],
    ['case', 'Token', 'token'],
  ])('%s changes the digest', (_label, a, b) => {
    expect(fallbackHash(a)).not.toBe(fallbackHash(b));
  });

  test('long inputs do not collapse to the same value', () => {
    const long = 'x'.repeat(5000);
    expect(fallbackHash(long)).not.toBe(fallbackHash(`${long}y`));
  });

  test('every one of the four lanes contributes to the digest', () => {
    // The digest is four independently-mixed 32-bit lanes rendered as four
    // 8-character segments. Asserting only that the whole string changes lets
    // three lanes carry a dead one — the digest still looks input-sensitive
    // while a quarter of its width is constant.
    const lanes = (input) => (fallbackHash(input).slice(0, 32).match(/.{8}/g) || []);
    const before = lanes('token-value');
    const after = lanes('token-valuf');

    expect(before).toHaveLength(4);
    before.forEach((lane, i) => expect(lane).not.toBe(after[i]));
  });
});

describe('randomHex', () => {
  test('returns two hex characters per byte asked for', () => {
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(32)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('defaults to sixteen bytes', () => {
    expect(randomHex()).toHaveLength(32);
  });

  test('does not repeat itself', () => {
    // A token generator that returns the same value twice is not a token
    // generator. This repo has shipped Math.random tokens before.
    const seen = new Set(Array.from({ length: 200 }, () => randomHex(16)));
    expect(seen.size).toBe(200);
  });

  test('the fallback still produces the right length', () => {
    const mod = withoutCryptoModule();
    expect(mod.randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(mod.randomHex(32)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the fallback still varies between calls', () => {
    // It is documented as not secure; it must at least not be constant, or a
    // crypto-less runtime would hand every session the same token.
    const mod = withoutCryptoModule();
    const seen = new Set(Array.from({ length: 50 }, () => mod.randomHex(16)));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('safeEqual', () => {
  const A = sha256('one');
  const B = sha256('two');

  // Run the whole contract against both implementations: the crypto-backed one
  // and the loop that replaces it when timingSafeEqual is unavailable. They are
  // separate code paths that have to agree, and only the first was tested.
  describe.each([
    ['with crypto', () => ({ safeEqual })],
    ['without crypto', withoutCryptoModule],
    ['with a crypto module lacking timingSafeEqual', withEmptyCryptoModule],
  ])('%s', (_label, load) => {
    const eq = (a, b) => load().safeEqual(a, b);

    test('equal digests compare equal', () => {
      expect(eq(A, A)).toBe(true);
    });

    test('different digests do not', () => {
      expect(eq(A, B)).toBe(false);
    });

    test('a digest differing only in its last character does not', () => {
      const almost = `${A.slice(0, -1)}${A.endsWith('0') ? '1' : '0'}`;
      expect(eq(A, almost)).toBe(false);
    });

    test('a digest differing only in its first character does not', () => {
      const almost = `${A.startsWith('0') ? '1' : '0'}${A.slice(1)}`;
      expect(eq(A, almost)).toBe(false);
    });

    test('different lengths do not compare equal', () => {
      expect(eq(A, A.slice(0, -2))).toBe(false);
    });

    test('a prefix does not compare equal to the whole', () => {
      expect(eq(A.slice(0, 8), A)).toBe(false);
    });

    test.each([
      ['both empty', '', ''],
      ['one empty', A, ''],
      ['both null', null, null],
      ['one null', A, null],
      ['both undefined', undefined, undefined],
    ])('%s compares false rather than true', (_l, a, b) => {
      // Failing open here would make an empty stored hash match an empty
      // supplied one, which is the shape of a bypass.
      expect(eq(a, b)).toBe(false);
    });
  });

  test('the fallback rejects a value padded with NUL rather than compared away', () => {
    // The loop pads the shorter side with charCode 0, so without the explicit
    // length term 'ab' and 'ab\0' would xor to zero and compare equal. The
    // padding is what makes the length check load-bearing rather than
    // redundant with the character comparison.
    const mod = withoutCryptoModule();
    expect(mod.safeEqual('ab', 'ab ')).toBe(false);
    expect(mod.safeEqual('ab ', 'ab')).toBe(false);
  });

  test('NOT COVERED: the constant-time property itself', () => {
    // The loop is written to compare every character rather than stop at the
    // first difference, which is most of the point of the function. That is a
    // property of how long the comparison takes, not of what it returns, so no
    // assertion here can see it.
    //
    // Checked rather than assumed: adding `if (diff !== 0) return false;` inside
    // the loop — same results, earlier exit — passes every test in this file.
    // What the tests below *do* catch is an early return that also drops the
    // length term, because that changes an answer. So the coverage boundary is
    // exactly "does it return something different", and constant-time sits
    // outside it. Timing assertions are too flaky to be worth their false
    // failures in CI.
    //
    // This exists to say so where someone editing the loop will read it.
    const mod = withoutCryptoModule();
    expect(mod.safeEqual(A, A)).toBe(true);
    expect(mod.safeEqual(A, B)).toBe(false);
  });

  test('a non-hex value never matches a real digest', () => {
    expect(safeEqual('not-hex-at-all', A)).toBe(false);
  });

  test('two identical non-hex values still compare false under crypto', () => {
    // They parse to zero bytes, and a zero-length comparison is rejected before
    // it can succeed.
    expect(safeEqual('zz', 'zz')).toBe(false);
  });

  test('CONTRACT: inputs are even-length hex, and odd-length ones compare on their whole-byte prefix', () => {
    // Buffer.from(x, 'hex') stops at the last complete byte, so 'abc' and 'abd'
    // both parse to the single byte 0xab and compare equal. Not reachable from
    // either caller — both pass sha256/pbkdf2 output, which is always
    // even-length hex — but pinned so the precondition is written down rather
    // than assumed by the next caller.
    expect(safeEqual('abc', 'abd')).toBe(true);
    expect(safeEqual('abc', 'abc')).toBe(true);

    // The fallback loop compares character by character and does not share the
    // assumption, which is why the two paths disagree here and nowhere else.
    expect(withoutCryptoModule().safeEqual('abc', 'abd')).toBe(false);
  });
});
