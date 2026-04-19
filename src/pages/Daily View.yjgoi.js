import wixLocation from 'wix-location';
import { getDailyOps, actOnDailyRequest } from 'backend/dailyOps';
import { buildUserContext, logoutBackroom, requireBackroomAccess, getSessionToken } from 'public/backroomAuth';
import { isTrustedBridgeOrigin, normalizeBridgeMessage, postMessageSafe, resolveHtmlComponent } from 'public/bridgeUtils';
import { APP_ROUTES as ROUTES } from 'public/appRoutes';
import { collapseHtmlSiblings } from 'public/pageVisibility';
const HTML_IDS = ['#dailyHtml', '#bpage1'];
const MIN_HEIGHT = 860;
const MAX_HEIGHT = 5200;
let requestedDate = '';
let pendingFocusBookingId = '';
let requestedTab = '';
let requestedViewMode = '';
let authState = null;

function logSuppressed(context, error) {
  console.warn(`[Daily View] ${context}`, error?.message || error || 'unknown error');
}

$w.onReady(async function () {
  authState = await requireBackroomAccess({ area: 'rentals', action: 'View' });
  if (!authState?.ok) return;

  requestedDate = normalizeDateParam((wixLocation.query || {}).date) || todayYMD();
  pendingFocusBookingId = String((wixLocation.query || {}).bookingId || '').trim();
  requestedTab = String((wixLocation.query || {}).tab || '').trim();
  requestedViewMode = String((wixLocation.query || {}).view || '').trim();
  hideOtherComponents(getHtmlIds());

  const html = getHtmlComponent();
  if (!html) return;
  try { html.expand(); html.show(); } catch (error) { logSuppressed('expand/show failed', error); }
  try { html.height = 1400; } catch (error) { logSuppressed('initial height set failed', error); }

  html.onMessage(async (event) => {
    if (!isTrustedBridgeOrigin(event?.origin, wixLocation.url)) return;
    const msg = normalizeBridgeMessage(event && event.data);
    if (!msg || typeof msg !== 'object' || !msg.type) return;

    if (msg.type === 'requestUserContext') {
      post(buildUserContext(authState, { siteBase: deriveSiteBase() }));
      return;
    }
    if (msg.type === 'menuAction') {
      const action = String(msg.action || '');
      if (action === 'reload') { await loadDailyOps({ requestedDate }); return; }
      if (action === 'logout') { await logoutBackroom(); wixLocation.to(ROUTES.home); return; }
    }
    if (msg.type === 'navigate') {
      const route = String(msg.route || '');
      if (route === 'home') return wixLocation.to(ROUTES.home);
      if (route === 'daily') return wixLocation.to(ROUTES.daily);
      if (route === 'fleet') return wixLocation.to(ROUTES.fleet);
      if (route === 'bookings') return wixLocation.to(ROUTES.bookings);
      if (route === 'settings') return wixLocation.to(ROUTES.settings);
    }
    if (msg.type === 'resizeShell') {
      const h = clampHeight(Number(msg.height || 0));
      if (h) { try { html.height = h; } catch (error) { logSuppressed('resizeShell height set failed', error); } }
      return;
    }
    if (msg.type === 'dailyReady' || msg.type === 'requestDailyReload' || msg.type === 'requestDailyData') {
      requestedDate = normalizeDateParam(msg.date) || requestedDate || todayYMD();
      await loadDailyOps({ requestedDate, startISO: msg.startISO, endISO: msg.endISO });
      return;
    }
    if (msg.type === 'openOnFleet') {
      const bookingId = String(msg.bookingId || '');
      const params = new URLSearchParams();
      if (bookingId) params.set('bookingId', bookingId);
      params.set('from', 'daily');
      const startDate = normalizeDateParam(msg.startDate) || normalizeDateParam(msg.date) || requestedDate;
      const endDate = normalizeDateParam(msg.endDate) || startDate;
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      if (requestedDate) params.set('date', requestedDate);
      wixLocation.to(`${ROUTES.fleet}?${params.toString()}`);
      return;
    }
    if (msg.type === 'openOnBookings') {
      const params = new URLSearchParams();
      params.set('from', 'daily');
      if (requestedDate) params.set('date', requestedDate);
      const bookingId = String(msg.bookingId || '');
      if (bookingId) params.set('bookingId', bookingId);
      const startDate = normalizeDateParam(msg.startDate) || normalizeDateParam(msg.date) || requestedDate;
      const endDate = normalizeDateParam(msg.endDate) || startDate || requestedDate;
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      wixLocation.to(`${ROUTES.bookings}?${params.toString()}`);
      return;
    }
    if (msg.type === 'openContract') {
      const bookingId = String(msg.bookingId || '');
      if (!bookingId) return;
      const params = new URLSearchParams();
      params.set('bookingId', bookingId);
      params.set('from', 'daily');
      if (requestedDate) params.set('date', requestedDate);
      wixLocation.to(`${ROUTES.contract}?${params.toString()}`);
      return;
    }
    if (msg.type === 'openVehicleCard') {
      const fleetVehicleId = String(msg.fleetVehicleId || msg.vehicleId || '').trim();
      if (!fleetVehicleId) return;
      const params = new URLSearchParams();
      params.set('fleetVehicleId', fleetVehicleId);
      params.set('from', 'daily');
      const bookingId = String(msg.bookingId || '').trim();
      if (bookingId) params.set('bookingId', bookingId);
      if (requestedDate) params.set('date', requestedDate);
      wixLocation.to(`${ROUTES.vehiclecard}?${params.toString()}`);
      return;
    }
    if (msg.type === 'dailyRequestAction') {
      const bookingId = String(msg.bookingId || '');
      const action = String(msg.action || '');
      const actorName = String(msg.actorName || '').trim();
      const note = String(msg.note || '').trim();
      const nextFollowUpAt = String(msg.nextFollowUpAt || '').trim();
      const targetOwner = String(msg.targetOwner || '').trim();
      if (!bookingId || !action) return;
      try {
        const result = await actOnDailyRequest({ authToken: resolveAuthToken(), bookingId, action, actorName, note, nextFollowUpAt, targetOwner });
        post({ type:'dailyActionResult', success: !!result?.success, message: result?.message || (result?.success ? 'Done' : 'Action failed') });
        await loadDailyOps({ requestedDate });
      } catch (error) {
        post({ type:'dailyActionResult', success:false, message:error?.message || String(error) });
      }
      return;
    }
  });

  post({ type: 'resume' });
  post(buildUserContext(authState, { siteBase: deriveSiteBase() }));
  await loadDailyOps({ requestedDate });
});

function resolveAuthToken() { return String((authState && authState.sessionToken) || getSessionToken() || '').trim(); }

function getHtmlIds() {
  return HTML_IDS.filter((id) => {
    try { return !!$w(id); } catch (error) { logSuppressed(`selector existence check failed for ${id}`, error); return false; }
  });
}
function getHtmlComponent() {
  try { return resolveHtmlComponent($w, getHtmlIds()); } catch (error) { logSuppressed('HtmlComponent lookup failed', error); }
  return null;
}
async function loadDailyOps({ requestedDate, startISO, endISO } = {}) {
  const date = normalizeDateParam(requestedDate) || todayYMD();
  const range = makeRange(date);
  const safeStart = validIso(startISO) || range.startISO;
  const safeEnd = validIso(endISO) || range.endISO;
  try {
    const res = await getDailyOps({ authToken: resolveAuthToken(), startISO: safeStart, endISO: safeEnd });
    if (res?.success === false) {
      post({ type:'loadDailyOps', checkOut:[], checkIn:[], bookings:[], tabs:{}, summary:{}, stations:[], debug:res.debug || { message: res.message || 'Daily load failed' } });
      return;
    }
    const tabs = res?.tabs || {};
    if ((!Array.isArray(tabs.checkout) || !tabs.checkout.length) && Array.isArray(res?.checkOut) && res.checkOut.length) tabs.checkout = res.checkOut;
    if ((!Array.isArray(tabs.checkin) || !tabs.checkin.length) && Array.isArray(res?.checkIn) && res.checkIn.length) tabs.checkin = res.checkIn;
    if ((!Array.isArray(tabs.bookings) || !tabs.bookings.length) && Array.isArray(res?.bookings) && res.bookings.length) tabs.bookings = res.bookings;
    post({
      type:'loadDailyOps',
      checkOut: Array.isArray(res?.checkOut) ? res.checkOut : [],
      checkIn: Array.isArray(res?.checkIn) ? res.checkIn : [],
      bookings: Array.isArray(res?.bookings) ? res.bookings : [],
      tabs,
      summary: res?.summary || {},
      stations: Array.isArray(res?.stations) ? res.stations : [],
      debug: res?.debug || {}
    });
    const focusId = String(pendingFocusBookingId || '').trim();
    if (focusId) {
      setTimeout(() => post({ type:'focusBooking', bookingId: focusId, preferredTab: requestedTab, viewMode: requestedViewMode }), 160);
      pendingFocusBookingId = '';
    }
  } catch (error) {
    post({ type:'loadDailyOps', checkOut:[], checkIn:[], bookings:[], tabs:{}, summary:{}, stations:[], debug:{ error: error?.message || String(error), startISO: safeStart, endISO: safeEnd } });
  }
}
function post(payload) {
  const html = getHtmlComponent();
  if (!html) return;
  if (!postMessageSafe(html, payload, 'daily-view')) logSuppressed('postMessage failed');
}
function hideOtherComponents(keepIds) {
  collapseHtmlSiblings($w, keepIds);
}
function clampHeight(value) { if (!Number.isFinite(value) || value <= 0) return null; return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(value))); }
function todayYMD() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function normalizeDateParam(value) { const raw = String(value || '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : ''; }
function validIso(value) { const raw = String(value || '').trim(); return raw && !Number.isNaN(new Date(raw).getTime()) ? raw : ''; }
function makeRange(dateStr) { const [y,m,d] = String(dateStr).split('-').map(Number); const start = new Date(y, (m||1)-1, d||1, 0,0,0,0); const end = new Date(y, (m||1)-1, d||1, 24,0,0,0); return { startISO:start.toISOString(), endISO:end.toISOString() }; }
function deriveSiteBase() {
  try {
    const u = new URL(wixLocation.url);
    const parts = String(u.pathname || '').split('/').filter(Boolean);
    if (parts.length <= 1) return u.origin;
    return `${u.origin}/${parts.slice(0, -1).join('/')}`;
  } catch (error) {
    logSuppressed('deriveSiteBase failed', error);
    return '';
  }
}
