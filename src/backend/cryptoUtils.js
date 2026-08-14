// @ts-check
// Shared crypto primitives for the backend.
//
// staffAccess and memberPortal each grew their own copy of these — same intent,
// slightly different fallbacks — which is how the two ended up with different
// answers to "is this token stored safely". One copy now, used by both.

let _cryptoApi;
/** Node's crypto module, or null in a runtime without it. */
export function getCrypto() {
  if (_cryptoApi !== undefined) return _cryptoApi;
  try {
    // In the Wix/Velo runtime a lazy require is more reliable than a top-level import.
    _cryptoApi = typeof require === 'function' ? require('crypto') : null;
  } catch (_) {
    _cryptoApi = null;
  }
  return _cryptoApi;
}

/**
 * Non-cryptographic digest, used only when the runtime exposes no crypto module.
 * Produces a 64-character hex string so callers see a consistent shape.
 * @param {string} [input]
 */
export function fallbackHash(input = '') {
  const value = String(input || '');
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  let h3 = 0xc2b2ae35;
  let h4 = 0x27d4eb2f;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
    h3 = Math.imul(h3 ^ c, 3266489917) >>> 0;
    h4 = Math.imul(h4 ^ c, 668265263) >>> 0;
  }
  const parts = [h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, '0'));
  return parts.join('').repeat(2).slice(0, 64);
}

/** SHA-256 hex digest. @param {any} value */
export function sha256(value) {
  const api = getCrypto();
  if (api?.createHash) return api.createHash('sha256').update(String(value || '')).digest('hex');
  return fallbackHash(String(value || ''));
}

/**
 * Cryptographically random hex string, `bytes * 2` characters long.
 * The fallback is not secure and exists only so a runtime without crypto still
 * functions; anything security-critical should be running with crypto available.
 * @param {number} [bytes]
 */
export function randomHex(bytes = 16) {
  const api = getCrypto();
  if (api?.randomBytes) return api.randomBytes(bytes).toString('hex');
  let out = '';
  while (out.length < bytes * 2) {
    out += `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')}`;
  }
  return out.slice(0, bytes * 2);
}

/**
 * Constant-time comparison of two hex digests. Falls back to a length-and-xor
 * loop when crypto.timingSafeEqual is unavailable.
 * @param {any} a
 * @param {any} b
 */
export function safeEqual(a, b) {
  const leftRaw = String(a || '');
  const rightRaw = String(b || '');
  const api = getCrypto();
  if (api?.timingSafeEqual) {
    try {
      const left = Buffer.from(leftRaw, 'hex');
      const right = Buffer.from(rightRaw, 'hex');
      if (left.length !== right.length || !left.length) return false;
      return api.timingSafeEqual(left, right);
    } catch (_) { /* fall through to the loop below */ }
  }
  const max = Math.max(leftRaw.length, rightRaw.length);
  if (!max) return false;
  let diff = leftRaw.length ^ rightRaw.length;
  for (let i = 0; i < max; i += 1) {
    const lc = i < leftRaw.length ? leftRaw.charCodeAt(i) : 0;
    const rc = i < rightRaw.length ? rightRaw.charCodeAt(i) : 0;
    diff |= (lc ^ rc);
  }
  return diff === 0;
}
