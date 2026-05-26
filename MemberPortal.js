// src/pages/Member Portal.XXXX.js
// ─────────────────────────────────────────────────────────────────────────────
// Wix page code — Member Portal
// Bridge between the HtmlComponent and memberPortal.jsw backend.
//
// SETUP:
//   1. Create a new Wix page named "Member Portal"
//   2. Add an HtmlComponent element, ID: memberPortalHtml
//   3. Set its source to the public file: member-portal/index.html
//   4. Stretch full page, hide Wix header/footer for this page
//   5. Paste this code into the page's code panel
//   6. Wix will auto-generate the filename suffix — use whatever it creates
// ─────────────────────────────────────────────────────────────────────────────

import {
  signIn,
  signOut,
  getCustomerBookings,
  getBookingDetail,
  updateBooking,
  cancelBooking,
  getCustomerProfile,
} from 'backend/memberPortal';

import {
  PORTAL_LOCATIONS,
  SITE_CURRENCY,
  SITE_NAME,
} from 'backend/siteConfig';

const HTML = '#memberPortalHtml';

$w.onReady(() => {
  $w(HTML).onMessage(async (event) => {
    const { type, payload = {} } = event.data || {};
    switch (type) {
      case 'PORTAL_READY':   handleReady();                 break;
      case 'SIGN_IN':        handleSignIn(payload);         break;
      case 'GET_BOOKINGS':   handleGetBookings(payload);    break;
      case 'GET_PROFILE':    handleGetProfile(payload);     break;
      case 'UPDATE_BOOKING': handleUpdateBooking(payload);  break;
      case 'CANCEL_BOOKING': handleCancelBooking(payload);  break;
      case 'SIGN_OUT':       handleSignOut(payload);        break;
    }
  });
});

function post(type, payload) {
  $w(HTML).postMessage({ type, payload });
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleReady() {
  post('INIT', {
    locations:      PORTAL_LOCATIONS || [],
    currency:       SITE_CURRENCY    || 'USD',
    companyName:    SITE_NAME        || 'Diamond Rent a Car',
    bookingPageUrl: '/booking',
  });
}

async function handleSignIn({ email, bookingRef } = {}) {
  try {
    const result = await signIn(email, bookingRef);
    post('AUTH_RESULT', result);
  } catch (e) {
    console.error('[MemberPortal] handleSignIn:', e.message);
    post('AUTH_RESULT', { ok: false, error: 'Server error. Please try again.' });
  }
}

async function handleGetBookings({ customerId, sessionToken, filter } = {}) {
  try {
    const result = await getCustomerBookings(customerId, sessionToken, filter || 'all');
    post('BOOKINGS_RESULT', result);
  } catch (e) {
    console.error('[MemberPortal] handleGetBookings:', e.message);
    post('BOOKINGS_RESULT', { ok: false, error: 'Failed to load bookings.' });
  }
}

async function handleGetProfile({ customerId, sessionToken } = {}) {
  try {
    const result = await getCustomerProfile(customerId, sessionToken);
    post('PROFILE_RESULT', result);
  } catch (e) {
    console.error('[MemberPortal] handleGetProfile:', e.message);
    post('PROFILE_RESULT', { ok: false, error: 'Failed to load profile.' });
  }
}

async function handleUpdateBooking({ bookingId, changes, customerId, sessionToken } = {}) {
  try {
    const result = await updateBooking(bookingId, changes, customerId, sessionToken);
    post('UPDATE_RESULT', result);
  } catch (e) {
    console.error('[MemberPortal] handleUpdateBooking:', e.message);
    post('UPDATE_RESULT', { ok: false, error: 'Update failed. Please try again.' });
  }
}

async function handleCancelBooking({ bookingId, reason, customerId, sessionToken } = {}) {
  try {
    const result = await cancelBooking(bookingId, customerId, sessionToken, reason);
    post('CANCEL_RESULT', result);
  } catch (e) {
    console.error('[MemberPortal] handleCancelBooking:', e.message);
    post('CANCEL_RESULT', { ok: false, error: 'Cancellation failed. Please try again.' });
  }
}

async function handleSignOut({ customerId, sessionToken } = {}) {
  try { await signOut(customerId, sessionToken); } catch (e) { /* non-critical */ }
  post('SIGN_OUT_RESULT', {});
}
