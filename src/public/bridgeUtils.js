export const BRIDGE_PROTOCOL_VERSION = '2026-04-06.1';
const TRUSTED_DOMAIN_SUFFIXES = ['wix.com', 'wixsite.com', 'parastorage.com', 'wixstatic.com'];
const bridgeTelemetry = {
  parseFailures: 0,
  postFallbacks: 0,
  postFailures: 0,
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

export function normalizeBridgeMessage(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (_) {
      bridgeTelemetry.parseFailures += 1;
      markTelemetry('parseFailures');
      return null;
    }
  }
  return raw;
}

export function buildBookingContext(wixLocation) {
  return {
    type: BRIDGE_TYPES.CONTEXT,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    query: wixLocation?.query || {},
    url: wixLocation?.url,
    path: wixLocation?.path || []
  };
}

export function postMessageSafe(component, payload, label = 'bridge') {
  if (!component || !payload) return false;
  try {
    component.postMessage(payload);
    return true;
  } catch (error) {
    bridgeTelemetry.postFallbacks += 1;
    markTelemetry('postFallbacks');
    try {
      component.postMessage(JSON.stringify(payload));
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
  const raw = String(origin || '').trim().toLowerCase();
  if (!raw) {
    bridgeTelemetry.untrustedOriginDrops += 1;
    markTelemetry('untrustedOriginDrops');
    return false;
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
      const current = new URL(String(currentUrl));
      const currentHost = String(current.hostname || '').toLowerCase();
      if (currentHost && sourceHost === currentHost) return true;
    }
    const trusted = TRUSTED_DOMAIN_SUFFIXES.some((suffix) => sourceHost === suffix || sourceHost.endsWith(`.${suffix}`));
    if (!trusted) {
      bridgeTelemetry.untrustedOriginDrops += 1;
      markTelemetry('untrustedOriginDrops');
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
  const perMinute = {
    parseFailures: recent.filter((entry) => entry.type === 'parseFailures').length,
    postFallbacks: recent.filter((entry) => entry.type === 'postFallbacks').length,
    postFailures: recent.filter((entry) => entry.type === 'postFailures').length,
    untrustedOriginDrops: recent.filter((entry) => entry.type === 'untrustedOriginDrops').length
  };
  return {
    ...bridgeTelemetry,
    perMinute,
    historyWindowMs: TELEMETRY_RATE_WINDOW_MS,
    historySize: bridgeTelemetryHistory.length
  };
}

export function resetBridgeTelemetry() {
  bridgeTelemetry.parseFailures = 0;
  bridgeTelemetry.postFallbacks = 0;
  bridgeTelemetry.postFailures = 0;
  bridgeTelemetry.untrustedOriginDrops = 0;
  bridgeTelemetryHistory.splice(0, bridgeTelemetryHistory.length);
}
