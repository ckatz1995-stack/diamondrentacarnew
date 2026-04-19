export const BRIDGE_PROTOCOL_VERSION = '2026-04-06.1';
const TRUSTED_DOMAIN_SUFFIXES = ['wix.com', 'wixsite.com', 'parastorage.com', 'wixstatic.com'];
const bridgeTelemetry = {
  parseAttempts: 0,
  parseSuccesses: 0,
  parseFailures: 0,
  postAttempts: 0,
  postSuccesses: 0,
  postFallbacks: 0,
  postFailures: 0,
  originChecks: 0,
  trustedOriginPasses: 0,
  untrustedOriginDrops: 0
};
const bridgeTelemetryHistory = [];
const TELEMETRY_HISTORY_LIMIT = 500;
const TELEMETRY_RATE_WINDOW_MS = 60_000;

function markTelemetry(eventType) {
  const type = String(eventType || '').trim();
  if (!type) return;
  bridgeTelemetryHistory.push({ ts: Date.now(), type });
  if (bridgeTelemetryHistory.length > TELEMETRY_HISTORY_LIMIT) {
    bridgeTelemetryHistory.splice(0, bridgeTelemetryHistory.length - TELEMETRY_HISTORY_LIMIT);
  }
}

export const BRIDGE_TYPES = {
  WIX_NAV: 'wix-booking-nav',
  REQUEST_CONTEXT: 'request-booking-context',
  CONTEXT: 'booking-context',
  REQUEST_PRICING: 'request-pricing-catalog-data',
  PRICING: 'pricing-catalog-data'
};

const SENSITIVE_QUERY_KEYS = ['password', 'pass', 'token', 'auth', 'session', 'secret', 'email', 'phone'];

function sanitizeQuery(query = {}) {
  const src = query && typeof query === 'object' ? query : {};
  return Object.keys(src).reduce((acc, key) => {
    const value = src[key];
    const lower = String(key || '').toLowerCase();
    const sensitive = SENSITIVE_QUERY_KEYS.some((needle) => lower.includes(needle));
    acc[key] = sensitive ? '' : value;
    return acc;
  }, {});
}

export function normalizeBridgeMessage(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    bridgeTelemetry.parseAttempts += 1;
    markTelemetry('parseAttempts');
    try {
      const parsed = JSON.parse(raw);
      bridgeTelemetry.parseSuccesses += 1;
      markTelemetry('parseSuccesses');
      return parsed;
    } catch (_) {
      bridgeTelemetry.parseFailures += 1;
      markTelemetry('parseFailures');
      return null;
    }
  }
  return raw;
}

export function buildBookingContext(wixLocation) {
  const query = wixLocation?.query || {};
  return {
    type: BRIDGE_TYPES.CONTEXT,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    query: sanitizeQuery(query),
    url: wixLocation?.url,
    path: wixLocation?.path || []
  };
}

export function postMessageSafe(component, payload, label = 'bridge') {
  if (!component || payload == null || typeof component.postMessage !== 'function') return false;
  bridgeTelemetry.postAttempts += 1;
  markTelemetry('postAttempts');
  try {
    component.postMessage(payload);
    bridgeTelemetry.postSuccesses += 1;
    markTelemetry('postSuccesses');
    return true;
  } catch (error) {
    bridgeTelemetry.postFallbacks += 1;
    markTelemetry('postFallbacks');
    try {
      const fallbackPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);
      component.postMessage(fallbackPayload);
      bridgeTelemetry.postSuccesses += 1;
      markTelemetry('postSuccesses');
      return true;
    } catch (innerError) {
      bridgeTelemetry.postFailures += 1;
      markTelemetry('postFailures');
      console.error(`[${label}] postMessage failed`, innerError || error);
      return false;
    }
  }
}

export function resolveHtmlComponent($w, candidates = []) {
  for (const selector of candidates) {
    try {
      const comp = $w(selector);
      if (comp) return comp;
    } catch (_) {}
  }
  try {
    const selection = $w('HtmlComponent');
    if (selection && typeof selection.forEach === 'function') {
      const items = [];
      selection.forEach((component) => items.push(component));
      if (items.length) return items[0];
    }
  } catch (_) {}
  return null;
}

export function isTrustedBridgeOrigin(origin, currentUrl) {
  bridgeTelemetry.originChecks += 1;
  markTelemetry('originChecks');
  const raw = String(origin || '').trim();
  if (!raw) {
    // Wix HtmlComponent can emit postMessage events without origin metadata.
    // Accept empty-origin events and rely on page-level message type validation.
    bridgeTelemetry.trustedOriginPasses += 1;
    markTelemetry('trustedOriginPasses');
    return true;
  }
  try {
    const source = new URL(raw);
    const sourceHost = String(source.hostname || '').toLowerCase();
    if (!sourceHost) {
      bridgeTelemetry.untrustedOriginDrops += 1;
      markTelemetry('untrustedOriginDrops');
      return false;
    }
    if (currentUrl) {
      try {
        const current = new URL(String(currentUrl));
        const currentHost = String(current.hostname || '').toLowerCase();
        if (currentHost && sourceHost === currentHost) {
          bridgeTelemetry.trustedOriginPasses += 1;
          markTelemetry('trustedOriginPasses');
          return true;
        }
      } catch (_) {
        // Ignore malformed currentUrl and fall back to trusted suffix matching.
      }
    }
    const trusted = TRUSTED_DOMAIN_SUFFIXES.some((suffix) => sourceHost === suffix || sourceHost.endsWith(`.${suffix}`));
    if (!trusted) {
      bridgeTelemetry.untrustedOriginDrops += 1;
      markTelemetry('untrustedOriginDrops');
    } else {
      bridgeTelemetry.trustedOriginPasses += 1;
      markTelemetry('trustedOriginPasses');
    }
    return trusted;
  } catch (_) {
    bridgeTelemetry.untrustedOriginDrops += 1;
    markTelemetry('untrustedOriginDrops');
    return false;
  }
}

export function getBridgeTelemetrySnapshot() {
  const now = Date.now();
  const windowStart = now - TELEMETRY_RATE_WINDOW_MS;
  const recent = bridgeTelemetryHistory.filter((entry) => entry.ts >= windowStart);
  const perMinute = recent.reduce((acc, entry) => {
    if (!acc[entry.type]) acc[entry.type] = 0;
    acc[entry.type] += 1;
    return acc;
  }, {
    parseAttempts: 0,
    parseSuccesses: 0,
    parseFailures: 0,
    postAttempts: 0,
    postSuccesses: 0,
    postFallbacks: 0,
    postFailures: 0,
    originChecks: 0,
    trustedOriginPasses: 0,
    untrustedOriginDrops: 0
  });
  const ratio = (num, denom) => (denom > 0 ? Number(((num / denom) * 100).toFixed(2)) : 0);
  const lastEvent = bridgeTelemetryHistory.length ? bridgeTelemetryHistory[bridgeTelemetryHistory.length - 1] : null;
  return {
    ...bridgeTelemetry,
    perMinute,
    rates: {
      parseFailurePct: ratio(bridgeTelemetry.parseFailures, bridgeTelemetry.parseAttempts),
      postFailurePct: ratio(bridgeTelemetry.postFailures, bridgeTelemetry.postAttempts),
      untrustedOriginPct: ratio(bridgeTelemetry.untrustedOriginDrops, bridgeTelemetry.originChecks)
    },
    windowRates: {
      parseFailurePct: ratio(perMinute.parseFailures, perMinute.parseAttempts),
      postFailurePct: ratio(perMinute.postFailures, perMinute.postAttempts),
      untrustedOriginPct: ratio(perMinute.untrustedOriginDrops, perMinute.originChecks)
    },
    historyWindowMs: TELEMETRY_RATE_WINDOW_MS,
    historySize: bridgeTelemetryHistory.length,
    lastEventAt: lastEvent?.ts || null,
    lastEventType: lastEvent?.type || null
  };
}

export function resetBridgeTelemetry() {
  bridgeTelemetry.parseAttempts = 0;
  bridgeTelemetry.parseSuccesses = 0;
  bridgeTelemetry.parseFailures = 0;
  bridgeTelemetry.postAttempts = 0;
  bridgeTelemetry.postSuccesses = 0;
  bridgeTelemetry.postFallbacks = 0;
  bridgeTelemetry.postFailures = 0;
  bridgeTelemetry.originChecks = 0;
  bridgeTelemetry.trustedOriginPasses = 0;
  bridgeTelemetry.untrustedOriginDrops = 0;
  bridgeTelemetryHistory.splice(0, bridgeTelemetryHistory.length);
}
