
import wixLocation from "wix-location";
import { getBookingsBoardData, setBookingBoardStatus } from "backend/bookingsBoard";
import { buildUserContext, logoutBackroom, requireBackroomAccess } from "public/backroomAuth";
import { isTrustedBridgeOrigin, normalizeBridgeMessage, postMessageSafe, resolveHtmlComponent } from "public/bridgeUtils";

const ROUTES = {
  home: "/myroom-home",
  daily: "/myroom-daily",
  fleet: "/myroom-fleetchart",
  bookings: "/myroom-bookingboard",
  contract: "/myroom-contract",
  settings: "/account-settings"
};

const HTML_ID = "#bookingsHtml";
const MIN_HEIGHT = 900;
const MAX_HEIGHT = 5000;
let pendingOpenBookingId = "";
let currentRange = defaultBoardRange();
let authState = null;

function logSuppressed(context, error) {
  console.warn(`[Booking Board] ${context}`, error?.message || error || 'unknown error');
}

$w.onReady(async function () {
  authState = await requireBackroomAccess({ area: 'bookings', action: 'View' });
  if (!authState?.ok) return;

  hideOtherComponents([HTML_ID]);
  pendingOpenBookingId = String((wixLocation.query || {}).bookingId || "").trim();
  currentRange = resolveInitialRange(wixLocation.query || {});

  const html = getHtmlComponent();
  if (!html) return;
  try { html.expand(); html.show(); } catch (error) { logSuppressed('expand/show failed', error); }
  try { html.height = 1700; } catch (error) { logSuppressed('initial height set failed', error); }

  html.onMessage(async (event) => {
    if (!isTrustedBridgeOrigin(event?.origin, wixLocation.url)) return;
    const msg = normalizeBridgeMessage(event && event.data);
    if (!msg || typeof msg !== 'object' || !msg.type) return;

    if (msg.type === "requestUserContext") {
      post(buildUserContext(authState, { siteBase: deriveSiteBase() }));
      return;
    }

    if (msg.type === "menuAction") {
      const action = String(msg.action || "");
      if (action === "reload") { await loadBoard(true); return; }
      if (action === "logout") {
        await logoutBackroom();
        wixLocation.to(ROUTES.home);
        return;
      }
    }

    if (msg.type === "navigate") {
      const route = String(msg.route || "");
      if (route === "home") return wixLocation.to(ROUTES.home);
      if (route === "daily") return wixLocation.to(ROUTES.daily);
      if (route === "fleet") return wixLocation.to(ROUTES.fleet);
      if (route === "bookings") return wixLocation.to(ROUTES.bookings);
      if (route === "settings") return wixLocation.to(ROUTES.settings);
    }

    if (msg.type === "resizeShell") {
      const h = clampHeight(Number(msg.height || 0));
      if (h) { try { html.height = h; } catch (error) { logSuppressed('resizeShell height set failed', error); } }
      return;
    }

    if (msg.type === "bookingsReady" || msg.type === "requestBookingsReload" || msg.type === "requestBoardData") {
      await loadBoard(true, msg);
      return;
    }

    if (msg.type === "openOnFleet") {
      const bookingId = String(msg.bookingId || "");
      const params = new URLSearchParams();
      if (bookingId) params.set('bookingId', bookingId);
      params.set('from', 'bookings');
      if (currentRange.startDate) params.set('startDate', currentRange.startDate);
      if (currentRange.endDate) params.set('endDate', currentRange.endDate);
      const url = `${ROUTES.fleet}?${params.toString()}`;
      wixLocation.to(url);
      return;
    }

    if (msg.type === "openContract") {
      const bookingId = String(msg.bookingId || "");
      if (!bookingId) return;
      const params = new URLSearchParams();
      params.set('bookingId', bookingId);
      params.set('from', 'bookings');
      params.set('mode', 'analysis');
      if (currentRange.startDate) params.set('startDate', currentRange.startDate);
      if (currentRange.endDate) params.set('endDate', currentRange.endDate);
      const url = `${ROUTES.contract}?${params.toString()}`;
      wixLocation.to(url);
      return;
    }

    if (msg.type === "openOnDaily") {
      const bookingId = String(msg.bookingId || "").trim();
      const date = normalizeDate(msg.date) || normalizeDate(msg.pickupDate) || currentRange.startDate;
      const viewMode = String(msg.viewMode || "full").trim() || 'full';
      const tab = String(msg.tab || "bookings").trim() || 'bookings';
      const params = new URLSearchParams();
      if (bookingId) params.set('bookingId', bookingId);
      if (date) params.set('date', date);
      if (viewMode) params.set('view', viewMode);
      if (tab) params.set('tab', tab);
      params.set('from', 'bookings');
      wixLocation.to(`${ROUTES.daily}?${params.toString()}`);
      return;
    }

    if (msg.type === "setStatus") {
      const result = await setBookingBoardStatus({ authToken: authState.sessionToken, bookingId: msg.bookingId, newStatus: msg.newStatus });
      post({ type: "toast", message: result?.success ? (result.message || "OK") : `Error: ${result?.message || "Failed"}` });
      if (msg.bookingId) pendingOpenBookingId = String(msg.bookingId);
      await loadBoard(true);
      return;
    }
  });

  post({ type: "resume" });
  post(buildUserContext(authState, { siteBase: deriveSiteBase() }));
  await loadBoard(true);
});

async function loadBoard(forceOpen = false, opts = {}) {
  try {
    const startDate = normalizeDate(opts.startDate) || currentRange.startDate;
    const endDate = normalizeDate(opts.endDate) || currentRange.endDate;
    currentRange = { startDate, endDate };

    const res = await getBookingsBoardData({ authToken: authState.sessionToken, startDate, endDate });
    post({ type: "loadBookings", items: Array.isArray(res?.items) ? res.items : [], filters: currentRange });
    const bookingId = String(pendingOpenBookingId || "");
    if (forceOpen && bookingId) setTimeout(() => post({ type: "focusBooking", bookingId }), 120);
  } catch (error) {
    post({ type: "loadBookings", items: [], filters: currentRange });
    post({ type: "toast", message: `Error: ${error?.message || String(error)}` });
  }
}

function post(payload) {
  const html = getHtmlComponent();
  if (!html) return;
  if (!postMessageSafe(html, payload, 'booking-board')) logSuppressed('postMessage failed');
}

function getHtmlComponent() {
  try { return resolveHtmlComponent($w, [HTML_ID]); } catch (error) { logSuppressed('HtmlComponent lookup failed', error); }
  return null;
}

function hideOtherComponents(keepIds) {
  ["#tabsHtml", "#homeHtml", "#dailyHtml", "#fleetCalendarHtml", "#bpage1", "#bpage2", "#bpage3", "#bpage4", "#html1", "#html2"].forEach(id => {
    if (keepIds.includes(id)) return;
    try { $w(id).collapse(); } catch (error) { logSuppressed(`collapse failed for ${id}`, error); }
    try { $w(id).hide(); } catch (error) { logSuppressed(`hide failed for ${id}`, error); }
  });
}

function clampHeight(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(value)));
}

function defaultBoardRange() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);
  return { startDate: toYMD(start), endDate: toYMD(end) };
}

function resolveInitialRange(query) {
  const fallback = defaultBoardRange();
  return {
    startDate: normalizeDate(query.startDate) || fallback.startDate,
    endDate: normalizeDate(query.endDate) || fallback.endDate
  };
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function toYMD(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function deriveSiteBase() {
  try {
    const u = new URL(wixLocation.url);
    const parts = String(u.pathname || "").split("/").filter(Boolean);
    if (parts.length <= 1) return u.origin;
    return `${u.origin}/${parts.slice(0, -1).join("/")}`;
  } catch (error) {
    logSuppressed('deriveSiteBase failed', error);
    return "";
  }
}
