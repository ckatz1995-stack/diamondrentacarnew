import wixLocation from 'wix-location';
import { getPublicAuthHealth } from 'backend/staffAccess.jsw';
import { buildUserContext, clearSessionToken, logoutBackroom, readBackroomSession } from 'public/backroomAuth';
import { isTrustedBridgeOrigin, normalizeBridgeMessage, postMessageSafe, resolveHtmlComponent } from 'public/bridgeUtils';

const ROUTES = {
  login: '/home-login',
  home: '/myroom-home',
  daily: '/myroom-daily',
  fleet: '/myroom-fleetchart',
  bookings: '/myroom-bookingboard',
  pricing: '/account-settings',
  settings: '/account-settings'
};
const HOME_IDS = ['#homeHtml', '#bpage1'];
const MIN_HEIGHT = 720;
const MAX_HEIGHT = 3200;

function logSuppressed(context, error) {
  console.warn(`[Myroom] ${context}`, error?.message || error || 'unknown error');
}

$w.onReady(async function () {
  const html = getHomeComponent();
  if (!html) return;
  hideOtherComponents();
  try { html.expand(); html.show(); } catch (error) { logSuppressed('expand/show failed', error); }

  const initialState = await readBackroomSession({ touch: true });
  if (!initialState?.authenticated) {
    return redirectToLogin();
  }

  html.onMessage(async (event) => {
    const origin = String(event?.origin || '').trim();
    const trustedOrigin = isTrustedBridgeOrigin(origin, wixLocation.url);
    // Wix HtmlComponent messages may be delivered without origin metadata.
    // Accept only empty-origin events; still block explicit untrusted origins.
    if (origin && !trustedOrigin) return;
    const msg = normalizeBridgeMessage(event && event.data);
    if (!msg || typeof msg !== 'object' || !msg.type) return;

    if (msg.type === 'navigate') {
      const state = await readBackroomSession({ touch: true });
      if (!state?.authenticated) {
        return redirectToLogin();
      }
      const route = String(msg.route || '');
      if (route === 'home') return wixLocation.to(ROUTES.home);
      if (route === 'daily') return wixLocation.to(ROUTES.daily);
      if (route === 'fleet') return wixLocation.to(ROUTES.fleet);
      if (route === 'bookings') return wixLocation.to(ROUTES.bookings);
      if (route === 'pricing' || route === 'settings') return wixLocation.to(ROUTES.pricing);
    }

    if (msg.type === 'resizeShell') {
      const h = clampHeight(Number(msg.height || 0));
      if (h) { try { html.height = h; } catch (error) { logSuppressed('resizeShell height set failed', error); } }
      return;
    }

    if (msg.type === 'homeReady' || msg.type === 'requestAuthState' || msg.type === 'requestUserContext') {
      await refreshAuthState();
      return;
    }

    if (msg.type === 'menuAction') {
      const action = String(msg.action || '');
      if (action === 'reload') return wixLocation.to(ROUTES.home);
      if (action === 'logout') {
        await logoutBackroom();
        clearSessionToken();
        await refreshAuthState('Έγινε αποσύνδεση από το backroom.');
      }
    }
  });

  await refreshAuthState();
});

function redirectToLogin() {
  const nextPath = wixLocation.path?.length ? `/${wixLocation.path.join('/')}` : ROUTES.home;
  wixLocation.to(`${ROUTES.login}?next=${encodeURIComponent(nextPath)}`);
}

async function refreshAuthState(message = '') {
  const state = await readBackroomSession({ touch: true });
  const denied = String((wixLocation.query || {}).denied || '') === '1';
  const nextPath = String((wixLocation.query || {}).next || '').trim();
  const authHealth = await getPublicAuthHealth().catch(() => null);
  post({
    type: 'authState',
    authenticated: !!state?.authenticated,
    user: state?.fullName || 'Operator',
    role: state?.roleLabel || 'Backroom',
    email: state?.email || '',
    permissions: state?.permissions || {},
    mustChangePassword: !!state?.mustChangePassword,
    expiresAt: state?.session?.expiresAt || null,
    nextPath,
    denied,
    errorMessage: message,
    authHealth: authHealth || null
  });
  post(buildUserContext(state));
}

function getHomeComponent() {
  try { return resolveHtmlComponent($w, HOME_IDS); } catch (error) { logSuppressed('HtmlComponent lookup failed', error); }
  return null;
}

function post(payload) {
  const html = getHomeComponent();
  if (!html) return;
  if (!postMessageSafe(html, payload, 'myroom-home')) logSuppressed('postMessage failed');
}

function clampHeight(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(value)));
}

function hideOtherComponents() {
  ['#tabsHtml', '#dailyHtml', '#fleetCalendarHtml', '#bookingsHtml'].forEach(id => {
    try { $w(id).collapse(); } catch (error) { logSuppressed(`collapse failed for ${id}`, error); }
    try { $w(id).hide(); } catch (error) { logSuppressed(`hide failed for ${id}`, error); }
  });
}
