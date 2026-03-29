import wixLocation from 'wix-location';
import { changeOwnPassword, getPublicAuthHealth, getPublicLoginBootstrap, loginStaff, requestAccessRecovery, revokeOwnOtherSessions } from 'backend/staffAccess.jsw';
import { buildUserContext, clearSessionToken, logoutBackroom, readBackroomSession, storeSessionToken } from 'public/backroomAuth';

const ROUTES = {
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

$w.onReady(async function () {
  const html = getHomeComponent();
  if (!html) return;
  hideOtherComponents();
  try { html.expand(); html.show(); } catch (_) {}

  html.onMessage(async (event) => {
    const msg = event.data || {};
    if (!msg.type) return;

    if (msg.type === 'navigate') {
      const state = await readBackroomSession({ touch: true });
      if (!state?.authenticated) {
        await refreshAuthState('Συνδέσου πρώτα για να μπεις στο backroom.');
        return;
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
      if (h) { try { html.height = h; } catch (_) {} }
      return;
    }

    if (msg.type === 'homeReady' || msg.type === 'requestAuthState' || msg.type === 'requestUserContext') {
      await refreshAuthState();
      return;
    }

    if (msg.type === 'requestLoginBootstrap') {
      await refreshAuthState();
      return;
    }

    if (msg.type === 'staffLogin') {
      await handleLogin(msg);
      return;
    }

    if (msg.type === 'requestAccessRecovery') {
      await handleRecoveryRequest(msg);
      return;
    }

    if (msg.type === 'changeOwnPassword') {
      await handleChangeOwnPassword(msg);
      return;
    }

    if (msg.type === 'logoutOtherSessions') {
      await handleLogoutOtherSessions();
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

async function handleLogin(msg = {}) {
  const email = String(msg.email || '').trim();
  const password = String(msg.password || '');
  const remember = !!msg.remember;
  try {
    const res = await loginStaff({
      email,
      password,
      remember,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : ''
    });
    storeSessionToken(res?.sessionToken || '', remember);
    await refreshAuthState('Η σύνδεση ολοκληρώθηκε.');
    const nextPath = String((wixLocation.query || {}).next || '').trim();
    if (nextPath && nextPath !== ROUTES.home) {
      wixLocation.to(nextPath);
    }
  } catch (err) {
    await refreshAuthState(err?.message || 'Η σύνδεση απέτυχε.');
  }
}


async function handleRecoveryRequest(msg = {}) {
  const email = String(msg.email || '').trim();
  try {
    const res = await requestAccessRecovery({
      email,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : ''
    });
    await refreshAuthState(res?.message || 'Το αίτημα recovery καταχωρήθηκε.');
  } catch (err) {
    await refreshAuthState(err?.message || 'Αποτυχία καταχώρησης recovery request.');
  }
}

async function handleChangeOwnPassword(msg = {}) {
  const state = await readBackroomSession({ touch: true });
  if (!state?.authenticated) {
    await refreshAuthState('Συνδέσου πρώτα για να αλλάξεις password.');
    return;
  }
  try {
    await changeOwnPassword({
      sessionToken: state.sessionToken,
      currentPassword: String(msg.currentPassword || ''),
      newPassword: String(msg.newPassword || '')
    });
    await refreshAuthState('Το password άλλαξε επιτυχώς.');
  } catch (err) {
    await refreshAuthState(err?.message || 'Αποτυχία αλλαγής password.');
  }
}

async function handleLogoutOtherSessions() {
  const state = await readBackroomSession({ touch: true });
  if (!state?.authenticated) {
    await refreshAuthState('Συνδέσου πρώτα για να ανακαλέσεις τα υπόλοιπα sessions.');
    return;
  }
  try {
    await revokeOwnOtherSessions({ sessionToken: state.sessionToken });
    await refreshAuthState('Ανακλήθηκαν τα υπόλοιπα active sessions αυτού του χρήστη.');
  } catch (err) {
    await refreshAuthState(err?.message || 'Αποτυχία ανάκλησης sessions.');
  }
}

async function refreshAuthState(message = '') {
  const state = await readBackroomSession({ touch: true });
  const denied = String((wixLocation.query || {}).denied || '') === '1';
  const nextPath = String((wixLocation.query || {}).next || '').trim();
  const [bootstrap, authHealth] = await Promise.all([
    getPublicLoginBootstrap().catch(() => null),
    getPublicAuthHealth().catch(() => null)
  ]);
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
    bootstrapHelp: bootstrap?.bootstrapPassword ? `Bootstrap password: ${bootstrap.bootstrapPassword}` : '',
    bootstrap: bootstrap || null,
    authHealth: authHealth || null
  });
  post(buildUserContext(state));
}

function getHomeComponent() {
  for (const id of HOME_IDS) {
    try { const cmp = $w(id); if (cmp) return cmp; } catch (_) {}
  }
  return null;
}

function post(payload) {
  const html = getHomeComponent();
  if (!html) return;
  try { html.postMessage(payload); } catch (_) {}
}

function clampHeight(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(value)));
}

function hideOtherComponents() {
  ['#tabsHtml', '#dailyHtml', '#fleetCalendarHtml', '#bookingsHtml'].forEach(id => {
    try { $w(id).collapse(); } catch (_) {}
    try { $w(id).hide(); } catch (_) {}
  });
}
