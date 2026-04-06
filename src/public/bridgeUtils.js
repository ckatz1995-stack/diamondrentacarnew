export const BRIDGE_PROTOCOL_VERSION = '2026-04-06.1';

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
    try {
      component.postMessage(JSON.stringify(payload));
      return true;
    } catch (innerError) {
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
