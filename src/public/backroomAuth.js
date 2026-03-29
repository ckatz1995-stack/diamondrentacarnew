import wixLocation from 'wix-location';
import { local, session } from 'wix-storage';
import { getSessionState, logoutStaff } from 'backend/staffAccess.jsw';

const STORAGE_KEY = 'diamond.backroom.session';

function capitalize(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

export function getSessionToken() {
  return local.getItem(STORAGE_KEY) || session.getItem(STORAGE_KEY) || '';
}

export function storeSessionToken(token, remember = false) {
  clearSessionToken();
  const safeToken = String(token || '').trim();
  if (!safeToken) return;
  // Always mirror the auth token into local storage so backroom pages opened in a
  // new tab can reuse the same custom session. If the operator also selected
  // "remember me", we keep the same token in local intentionally. If not, we still
  // place it in session storage too so the current tab keeps working even if local
  // storage is unavailable in a given browser context.
  try { local.setItem(STORAGE_KEY, safeToken); } catch (_) {}
  if (!remember) {
    try { session.setItem(STORAGE_KEY, safeToken); } catch (_) {}
  }
}

export function clearSessionToken() {
  try { local.removeItem(STORAGE_KEY); } catch (_) {}
  try { session.removeItem(STORAGE_KEY); } catch (_) {}
}

export async function readBackroomSession({ touch = true } = {}) {
  const sessionToken = getSessionToken();
  if (!sessionToken) return { authenticated: false, sessionToken: '' };
  try {
    const state = await getSessionState({ sessionToken, touch });
    if (!state?.authenticated) {
      clearSessionToken();
      return { authenticated: false, sessionToken: '' };
    }
    return { ...state, sessionToken };
  } catch (_) {
    clearSessionToken();
    return { authenticated: false, sessionToken: '' };
  }
}

export function hasBackroomPermission(permissions = {}, area = '', action = 'View') {
  const safeArea = String(area || '').trim();
  if (!safeArea) return true;
  const key = `${safeArea}${capitalize(action || 'View')}`;
  return !!permissions[key];
}

export async function requireBackroomAccess({ area = '', action = 'View', redirectTo = '/myroom-home' } = {}) {
  const state = await readBackroomSession({ touch: true });
  const allowed = !!state?.authenticated && hasBackroomPermission(state.permissions || {}, area, action);
  if (allowed) return { ok: true, ...state };
  const nextPath = `/${(wixLocation.path || []).join('/')}`;
  const params = new URLSearchParams();
  if (nextPath && nextPath !== '/') params.set('next', nextPath);
  if (state?.authenticated && !allowed) params.set('denied', '1');
  const target = params.toString() ? `${redirectTo}?${params.toString()}` : redirectTo;
  try { wixLocation.to(target); } catch (_) {}
  return { ok: false, ...state };
}

export async function logoutBackroom() {
  const sessionToken = getSessionToken();
  clearSessionToken();
  if (sessionToken) {
    try { await logoutStaff({ sessionToken }); } catch (_) {}
  }
  return true;
}

export function buildUserContext(state = {}, extra = {}) {
  return {
    type: 'userContext',
    name: state?.fullName || 'Operator',
    role: state?.roleLabel || 'Backroom',
    email: state?.email || '',
    company: 'DIAMOND Backroom',
    station: 'Operations Center',
    mustChangePassword: !!state?.mustChangePassword,
    ...extra
  };
}
