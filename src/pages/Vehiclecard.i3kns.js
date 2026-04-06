
import wixLocation from 'wix-location';
import { requireBackroomAccess, logoutBackroom } from 'public/backroomAuth';
import { getVehicleCardData, saveVehicleCardData } from 'backend/vehicleCard';

const HTML_ID = '#vehicleCardHtml';
const ROUTES = {
  home: '/myroom-home',
  daily: '/myroom-daily',
  fleet: '/myroom-fleetchart',
  bookings: '/myroom-bookingboard',
  contract: '/myroom-contract',
  settings: '/account-settings'
};

let authState = null;
let fleetVehicleId = '';
let returnTab = 'fleet';

function logSuppressed(context, error) {
  console.warn(`[Vehicle Card] ${context}`, error?.message || error || 'unknown error');
}

$w.onReady(async function () {
  authState = await requireBackroomAccess({ area: 'fleet', action: 'View' });
  if (!authState?.ok) return;

  const query = wixLocation.query || {};
  fleetVehicleId = String(query.fleetVehicleId || query.id || '').trim();
  returnTab = String(query.from || 'fleet').trim() || 'fleet';

  const html = $w(HTML_ID);
  try { html.expand(); html.height = 1400; } catch (error) { logSuppressed('expand/initial height failed', error); }

  html.onMessage(async (event) => {
    const msg = event.data || {};
    if (!msg.type) return;

    if (msg.type === 'vehicleCardReady') {
      await loadVehicleCard();
      return;
    }
    if (msg.type === 'saveVehicleCard') {
      await saveVehicleCard(msg.patch || {});
      return;
    }
    if (msg.type === 'resize') {
      const h = Math.min(Math.max(Number(msg.height || 0), 900), 5000);
      if (h) { try { html.height = h; } catch (error) { logSuppressed('resize height set failed', error); } }
      return;
    }
    if (msg.type === 'back') {
      wixLocation.to(returnTab === 'bookings' ? ROUTES.bookings : ROUTES.fleet);
      return;
    }
    if (msg.type === 'logout') {
      await logoutBackroom();
      wixLocation.to(ROUTES.home);
      return;
    }
    if (msg.type === 'navigate') {
      const route = String(msg.route || '').trim();
      const target = ROUTES[route];
      if (target) wixLocation.to(target);
      return;
    }
    if (msg.type === 'openContract') {
      const bookingId = String(msg.bookingId || '').trim();
      if (!bookingId) return;
      const params = new URLSearchParams();
      params.set('bookingId', bookingId);
      params.set('from', 'fleet');
      wixLocation.to(`${ROUTES.contract}?${params.toString()}`);
      return;
    }
  });
});

function post(payload) {
  try { $w(HTML_ID).postMessage(payload); } catch (error) { logSuppressed('postMessage failed', error); }
}

async function loadVehicleCard() {
  if (!fleetVehicleId) {
    post({ type: 'toast', message: 'Missing fleetVehicleId in URL.' });
    return;
  }
  try {
    const res = await getVehicleCardData({ sessionToken: authState.sessionToken, fleetVehicleId });
    post({
      type: 'loadVehicleCardData',
      data: res,
      context: {
        user: authState.fullName || authState.email || 'Operator',
        returnTab
      }
    });
  } catch (err) {
    post({ type: 'toast', message: err?.message || 'Failed to load vehicle card.' });
    post({ type: 'loadVehicleCardData', data: { fleet:{}, category:{}, summary:{}, rentals:[] }, context: { user: authState.fullName || authState.email || 'Operator' } });
  }
}

async function saveVehicleCard(patch) {
  try {
    const res = await saveVehicleCardData({ sessionToken: authState.sessionToken, fleetVehicleId, patch });
    post({ type: 'toast', message: 'Vehicle saved.' });
    post({ type: 'saveState', fleet: res.fleet || null });
    await loadVehicleCard();
  } catch (err) {
    post({ type: 'toast', message: err?.message || 'Failed to save vehicle.' });
  }
}
