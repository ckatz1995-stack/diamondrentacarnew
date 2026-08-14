import { sha256, randomHex, derivePasswordHash, safeEqual } from '../staffAccess.jsw';

describe('sha256', () => {
  test('is deterministic for the same input', () => {
    expect(sha256('hello')).toBe(sha256('hello'));
  });

  test('returns a 64-character hex digest', () => {
    expect(sha256('hello')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('produces different digests for different inputs', () => {
    expect(sha256('hello')).not.toBe(sha256('world'));
  });
});

describe('randomHex', () => {
  test('returns a hex string of the requested byte length', () => {
    const value = randomHex(16);
    expect(value).toMatch(/^[0-9a-f]{32}$/);
  });

  test('returns different values across calls', () => {
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});

describe('derivePasswordHash', () => {
  test('is deterministic for the same password and salt', () => {
    const salt = randomHex(8);
    expect(derivePasswordHash('correct horse', salt)).toBe(derivePasswordHash('correct horse', salt));
  });

  test('produces a different hash for a different salt', () => {
    const hashA = derivePasswordHash('correct horse', 'salt-a');
    const hashB = derivePasswordHash('correct horse', 'salt-b');
    expect(hashA).not.toBe(hashB);
  });

  test('produces a different hash for a different password', () => {
    const salt = 'same-salt';
    expect(derivePasswordHash('password-one', salt)).not.toBe(derivePasswordHash('password-two', salt));
  });

  test('returns a 64-character hex digest (32-byte key length)', () => {
    expect(derivePasswordHash('correct horse', 'salt')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('safeEqual', () => {
  test('returns true for identical hex strings', () => {
    const hash = derivePasswordHash('correct horse', 'salt');
    expect(safeEqual(hash, hash)).toBe(true);
  });

  test('returns false for different hex strings of the same length', () => {
    const hashA = derivePasswordHash('correct horse', 'salt-a');
    const hashB = derivePasswordHash('correct horse', 'salt-b');
    expect(safeEqual(hashA, hashB)).toBe(false);
  });

  test('returns false when lengths differ', () => {
    expect(safeEqual('abcd', 'abcdef')).toBe(false);
  });

  test('returns false when both inputs are empty', () => {
    expect(safeEqual('', '')).toBe(false);
  });
});
