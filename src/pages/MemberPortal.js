import wixLocation from 'wix-location';
import * as memberPortal from 'backend/memberPortal';
import { PORTAL_LOCATIONS, SITE_CURRENCY, SITE_NAME } from 'backend/siteConfig';
import { isTrustedBridgeOrigin, normalizeBridgeMessage, postMessageSafe, resolveHtmlComponent } from 'public/bridgeUtils';

const COMP = '#memberPortalHtml';

function getComponent() {
  return resolveHtmlComponent($w, [COMP]);
}

function post(payload) {
  return postMessageSafe(getComponent(), payload, 'MemberPortal');
}

async function handleMessage(event) {
  const origin = String(event?.origin || '').trim();
  if (origin && !isTrustedBridgeOrigin(origin, wixLocation.url)) return;
  const data = normalizeBridgeMessage(event && event.data);
  if (!data || !data.type) return;

  switch (data.type) {
    case 'PORTAL_READY':
      post({
        type: 'INIT',
        locations: PORTAL_LOCATIONS || [],
        currency: SITE_CURRENCY || 'EUR',
        companyName: SITE_NAME || 'Diamond Rent a Car',
        bookingPageUrl: '/booking'
      });
      break;

    case 'SIGN_IN':
      try {
        const r = await memberPortal.signIn({ email: data.email, bookingRef: data.bookingRef });
        post({ type: 'AUTH_RESULT', ...r });
      } catch (_) {
        post({ type: 'AUTH_RESULT', ok: false, error: 'server_error' });
      }
      break;

    case 'GET_BOOKINGS':
      try {
        const r = await memberPortal.getCustomerBookings({
          customerId: data.customerId,
          sessionToken: data.sessionToken,
          filter: data.filter
        });
        post({ type: 'BOOKINGS_RESULT', ...r });
      } catch (_) {
        post({ type: 'BOOKINGS_RESULT', ok: false, error: 'server_error' });
      }
      break;

    case 'GET_PROFILE':
      try {
        const r = await memberPortal.getCustomerProfile({
          customerId: data.customerId,
          sessionToken: data.sessionToken
        });
        post({ type: 'PROFILE_RESULT', ...r });
      } catch (_) {
        post({ type: 'PROFILE_RESULT', ok: false, error: 'server_error' });
      }
      break;

    case 'UPDATE_BOOKING':
      try {
        const r = await memberPortal.updateBooking({
          bookingId: data.bookingId,
          changes: data.changes,
          customerId: data.customerId,
          sessionToken: data.sessionToken
        });
        post({ type: 'UPDATE_RESULT', ...r });
      } catch (_) {
        post({ type: 'UPDATE_RESULT', ok: false, error: 'server_error' });
      }
      break;

    case 'CANCEL_BOOKING':
      try {
        const r = await memberPortal.cancelBooking({
          bookingId: data.bookingId,
          reason: data.reason,
          customerId: data.customerId,
          sessionToken: data.sessionToken
        });
        post({ type: 'CANCEL_RESULT', ...r });
      } catch (_) {
        post({ type: 'CANCEL_RESULT', ok: false, error: 'server_error' });
      }
      break;

    case 'SIGN_OUT':
      try {
        await memberPortal.signOut({
          customerId: data.customerId,
          sessionToken: data.sessionToken
        });
      } catch (_) {}
      post({ type: 'SIGN_OUT_RESULT' });
      break;

    default:
      break;
  }
}

$w.onReady(function () {
  const comp = getComponent();
  if (comp) {
    try { comp.onMessage(handleMessage); } catch (e) { console.error('MemberPortal bind failed', e); }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('message', (event) => {
      if (!isTrustedBridgeOrigin(event?.origin, wixLocation.url)) return;
      handleMessage(event);
    });
  }
});
