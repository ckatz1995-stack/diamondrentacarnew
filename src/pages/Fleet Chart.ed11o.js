
import wixLocation from 'wix-location';
import { getFleetCalendarData, moveBookingVehicleOnly, confirmAndAutoAssign } from 'backend/fleetCalendar';
import { buildUserContext, logoutBackroom, requireBackroomAccess } from 'public/backroomAuth';
import { isTrustedBridgeOrigin, normalizeBridgeMessage, postMessageSafe, resolveHtmlComponent } from 'public/bridgeUtils';

const ROUTES = {
  home: '/myroom-home',
  daily: '/myroom-daily',
  fleet: '/myroom-fleetchart',
  bookings: '/myroom-bookingboard',
  contract: '/myroom-contract',
  vehiclecard: '/vehiclecard',
  settings: '/account-settings'
};

const HTML_ID = '#fleetCalendarHtml';
const MIN_HEIGHT = 900;
const MAX_HEIGHT = 5000;
let pendingFocusBookingId = '';
let lastRange = { from: '', to: '' };
let authState = null;

function logSuppressed(context, error) {
  console.warn(`[Fleet Chart] ${context}`, error?.message || error || 'unknown error');
}

$w.onReady(async function () {
  authState = await requireBackroomAccess({ area: 'fleet', action: 'View' });
  if (!authState?.ok) return;

  hideOtherComponents([HTML_ID]);
  pendingFocusBookingId = String((wixLocation.query || {}).bookingId || '').trim();

  const html = getHtmlComponent();
  if (!html) return;
  try { html.expand(); html.show(); } catch (error) { logSuppressed('expand/show failed', error); }
  try { html.height = 1250; } catch (error) { logSuppressed('initial height set failed', error); }

  html.onMessage(async (event) => {
    if (!isTrustedBridgeOrigin(event?.origin, wixLocation.url)) return;
    const msg = normalizeBridgeMessage(event && event.data);
    if (!msg || typeof msg !== 'object' || !msg.type) return;

    if (msg.type === 'requestUserContext') {
      post(buildUserContext(authState));
      return;
    }

    if (msg.type === 'navigate') {
      const route = String(msg.route || '');
      if (route === 'home') return wixLocation.to(ROUTES.home);
      if (route === 'daily') return wixLocation.to(ROUTES.daily);
      if (route === 'fleet') return wixLocation.to(ROUTES.fleet);
      if (route === 'bookings') return wixLocation.to(ROUTES.bookings);
      if (route === 'settings') return wixLocation.to(ROUTES.settings);
    }

    if (msg.type === 'menuAction') {
      const action = String(msg.action || '');
      if (action === 'reload') { await loadCalendar(lastRange, true); return; }
      if (action === 'logout') {
        await logoutBackroom();
        wixLocation.to(ROUTES.home);
        return;
      }
    }

    if (msg.type === 'resizeShell') {
      const h = clampHeight(Number(msg.height || 0));
      if (h) { try { html.height = h; } catch (error) { logSuppressed('resizeShell height set failed', error); } }
      return;
    }

    if (msg.type === 'calendarReady' || msg.type === 'requestReload') {
      lastRange = { from: String(msg.from || lastRange.from || ''), to: String(msg.to || lastRange.to || '') };
      await loadCalendar(lastRange, true);
      return;
    }

    if (msg.type === 'moveBooking') {
      const result = await moveBookingVehicleOnly({ authToken: authState.sessionToken, bookingId: msg.bookingId, newVehicleId: msg.newVehicleId });
      if (!result?.success) {
        post({ type: 'moveRejected', bookingId: String(msg.bookingId || ''), reason: result?.message || 'Move failed' });
        post({ type: 'toast', message: `Move rejected: ${result?.message || 'failed'}` });
        return;
      }
      await loadCalendar(lastRange, false);
      return;
    }

    if (msg.type === 'autoAssignSingle') {
      const result = await confirmAndAutoAssign({ authToken: authState.sessionToken, bookingId: msg.bookingId });
      post({ type: 'toast', message: result?.success ? (result?.assigned ? 'Vehicle auto-assigned' : 'Confirmed without assignment') : `Auto-assign failed: ${result?.message || 'error'}` });
      await loadCalendar(lastRange, false);
      return;
    }

    if (msg.type === 'autoAssignUnassigned') {
      await autoAssignRange(msg.from, msg.to);
      return;
    }

    if (msg.type === 'focusBooking') {
      post({ type: 'focusBooking', bookingId: String(msg.bookingId || '') });
      return;
    }


    if (msg.type === 'openOnDaily') {
      const bookingId = String(msg.bookingId || '').trim();
      const date = normalizeDate(msg.date) || normalizeDate(lastRange.from);
      const params = new URLSearchParams();
      if (bookingId) params.set('bookingId', bookingId);
      if (date) params.set('date', date);
      params.set('view', String(msg.viewMode || 'full'));
      params.set('tab', String(msg.tab || 'bookings'));
      params.set('from', 'fleet');
      wixLocation.to(`${ROUTES.daily}?${params.toString()}`);
      return;
    }

    if (msg.type === 'openOnBookings') {
      const bookingId = String(msg.bookingId || '').trim();
      const startDate = normalizeDate(msg.startDate) || normalizeDate(lastRange.from);
      const endDate = normalizeDate(msg.endDate) || normalizeDate(lastRange.to) || startDate;
      const params = new URLSearchParams();
      if (bookingId) params.set('bookingId', bookingId);
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      params.set('from', 'fleet');
      wixLocation.to(`${ROUTES.bookings}?${params.toString()}`);
      return;
    }

    if (msg.type === 'openContract') {
      const bookingId = String(msg.bookingId || '');
      if (!bookingId) return;
      const params = new URLSearchParams();
      params.set('bookingId', bookingId);
      params.set('from', 'fleet');
      if (lastRange.from) params.set('startDate', lastRange.from);
      if (lastRange.to) params.set('endDate', lastRange.to);
      wixLocation.to(`${ROUTES.contract}?${params.toString()}`);
      return;
    }

    if (msg.type === 'openVehicleCard') {
      const fleetVehicleId = String(msg.fleetVehicleId || msg.vehicleId || '').trim();
      if (!fleetVehicleId) return;
      const params = new URLSearchParams();
      params.set('fleetVehicleId', fleetVehicleId);
      params.set('from', 'fleet');
      if (msg.bookingId) params.set('bookingId', String(msg.bookingId));
      if (lastRange.from) params.set('startDate', lastRange.from);
      if (lastRange.to) params.set('endDate', lastRange.to);
      wixLocation.to(`${ROUTES.vehiclecard}?${params.toString()}`);
      return;
    }
  });

  post({ type: 'resume' });
  post(buildUserContext(authState));
  await loadCalendar(lastRange, true);
});

async function autoAssignRange(from, to) {
  try {
    const data = await getFleetCalendarData({ authToken: authState.sessionToken, from, to });
    const items = Array.isArray(data?.unassigned) ? data.unassigned : [];
    let ok = 0;
    for (const item of items) {
      const bookingId = String(item?.id || '');
      if (!bookingId) continue;
      const res = await confirmAndAutoAssign({ authToken: authState.sessionToken, bookingId });
      if (res?.success) ok += 1;
    }
    post({ type: 'toast', message: ok ? `Auto-assigned ${ok} booking(s)` : 'No unassigned bookings to auto-assign' });
    await loadCalendar({ from, to }, false);
  } catch (error) {
    post({ type: 'toast', message: `Auto-assign failed: ${error?.message || String(error)}` });
  }
}

async function loadCalendar(range = {}, full = true) {
  try {
    const from = String(range?.from || lastRange.from || '').trim();
    const to = String(range?.to || lastRange.to || '').trim();
    const res = await getFleetCalendarData({ authToken: authState.sessionToken, from, to });
    lastRange = { from, to };
    post({
      type: full ? 'loadData' : 'patchItems',
      groups: Array.isArray(res?.groups) ? res.groups : [],
      items: Array.isArray(res?.items) ? res.items : [],
      unassigned: Array.isArray(res?.unassigned) ? res.unassigned : []
    });
    const bookingId = String(pendingFocusBookingId || '').trim();
    if (bookingId) {
      setTimeout(() => post({ type: 'focusBooking', bookingId }), 180);
      pendingFocusBookingId = '';
    }
  } catch (error) {
    post({ type: 'showError', message: error?.message || String(error) });
  }
}

function post(payload) {
  const html = getHtmlComponent();
  if (!html) return;
  if (!postMessageSafe(html, payload, 'fleet-chart')) logSuppressed('postMessage failed');
}

function getHtmlComponent() {
  try { return resolveHtmlComponent($w, [HTML_ID]); } catch (error) { logSuppressed('HtmlComponent lookup failed', error); }
  return null;
}

function hideOtherComponents(keepIds) {
  ['#tabsHtml', '#homeHtml', '#dailyHtml', '#bookingsHtml', '#bpage1', '#bpage2', '#bpage3', '#bpage4', '#html1', '#html2'].forEach(id => {
    if (keepIds.includes(id)) return;
    let component = null;
    try { component = $w(id); } catch (error) { logSuppressed(`lookup failed for ${id}`, error); }
    if (!component) return;
    if (typeof component.collapse === 'function') {
      try { component.collapse(); } catch (error) { logSuppressed(`collapse failed for ${id}`, error); }
    }
    if (typeof component.hide === 'function') {
      try { component.hide(); } catch (error) { logSuppressed(`hide failed for ${id}`, error); }
    }
  });
}

function clampHeight(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(value)));
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}
