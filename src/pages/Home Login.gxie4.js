import wixLocation from 'wix-location';
import { getPublicAuthHealth, getPublicLoginBootstrap, loginStaff, requestAccessRecovery } from 'backend/staffAccess.jsw';
import { buildUserContext, readBackroomSession, storeSessionToken } from 'public/backroomAuth';
import { isTrustedBridgeOrigin, normalizeBridgeMessage, postMessageSafe, resolveHtmlComponent } from 'public/bridgeUtils';

const ROUTES = {
  home: '/myroom-home'
};

const LOGIN_COMPONENT_IDS = ['#loginHtml', '#homeHtml', '#bpage1', '#html1', '#html2', '#customElement1'];
const MIN_HEIGHT = 640;
const MAX_HEIGHT = 2400;

function logSuppressed(context, error) {
  console.warn(`[Home Login] ${context}`, error?.message || error || 'unknown error');
}

$w.onReady(async function () {
  const html = getLoginComponent();
  if (!html) return;

  try { html.expand(); html.show(); } catch (error) { logSuppressed('expand/show failed', error); }

  html.onMessage(async (event) => {
    const origin = String(event?.origin || '').trim();
    const trustedOrigin = isTrustedBridgeOrigin(origin, wixLocation.url);
    // Wix HtmlComponent messages can occasionally arrive without origin metadata.
    // In that case we still accept the payload and rely on strict message-type handling below.
    if (origin && !trustedOrigin) return;
    const msg = normalizeBridgeMessage(event && event.data);
    if (!msg || typeof msg !== 'object' || !msg.type) return;

    if (msg.type === 'loginReady' || msg.type === 'requestAuthState' || msg.type === 'requestLoginBootstrap') {
      await refreshAuthState();
      return;
    }

    if (msg.type === 'resizeShell') {
      const h = clampHeight(Number(msg.height || 0));
      if (h) { try { html.height = h; } catch (error) { logSuppressed('resizeShell height set failed', error); } }
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
    wixLocation.to(nextPath || ROUTES.home);
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

function getLoginComponent() {
  try { return resolveHtmlComponent($w, LOGIN_COMPONENT_IDS); } catch (error) { logSuppressed('HtmlComponent lookup failed', error); }
  return null;
}

function post(payload) {
  const html = getLoginComponent();
  if (!html) return;
  if (!postMessageSafe(html, payload, 'home-login')) logSuppressed('postMessage failed');
}

function clampHeight(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(value)));
}
