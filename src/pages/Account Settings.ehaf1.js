import wixLocation from 'wix-location';
import {
  getPricingAdminSnapshot,
  saveBusinessSettings,
  upsertInsurancePlan,
  upsertExtraService,
  upsertFeeRule,
  deletePricingItem,
  upsertVehicleCategory,
  deleteVehicleCategory,
  upsertFleetVehicle,
  deleteFleetVehicle,
  upsertPricingSeason,
  deletePricingSeason,
  upsertCategoryRateRule,
  deleteCategoryRateRule,
  upsertPickupLocation,
  deletePickupLocation,
  seedPricingDefaults,
  resetPricingDefaults
} from 'backend/pricingAdmin.jsw';
import {
  getStaffAccessSnapshot,
  upsertStaffRole,
  upsertStaffUser,
  inviteStaffUser,
  deactivateStaffUser,
  reactivateStaffUser,
  setStaffPassword,
  resetStaffPassword,
  revokeStaffSessions
} from 'backend/staffAccess.jsw';
import { logoutBackroom, requireBackroomAccess } from 'public/backroomAuth';
import { getBridgeTelemetrySnapshot, resetBridgeTelemetry } from 'public/bridgeUtils';
import { APP_ROUTES as ROUTES } from 'public/appRoutes';

const COMP = '#pricingAdminHtml';
let authState = null;
let currentUser = 'admin';

function normalizeMessage(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (_) { return null; }
  }
  return raw;
}

function post(payload) {
  try { $w(COMP).postMessage(payload); } catch (e) { console.error('pricing admin postMessage failed', e); }
}

function sendBridgeTelemetrySnapshot(message = '') {
  post({ type: 'bridgeTelemetrySnapshot', telemetry: getBridgeTelemetrySnapshot(), message });
}

async function sendSnapshots(message = '', tone = 'success') {
  try {
    const [snapshot, accessSnapshot] = await Promise.all([
      getPricingAdminSnapshot({ authToken: authState.sessionToken }),
      getStaffAccessSnapshot({ sessionToken: authState.sessionToken })
    ]);
    post({
      type: 'adminSnapshot',
      snapshot,
      accessSnapshot,
      meta: { user: currentUser, bridgeTelemetry: getBridgeTelemetrySnapshot() }
    });
    if (message) post({ type: 'toast', tone, message });
  } catch (err) {
    post({ type: 'toast', tone: 'error', message: err?.message || String(err) || 'Αποτυχία φόρτωσης admin snapshot.' });
  } finally {
    post({ type: 'busy', flag: false });
  }
}

async function handleAction(type, payload = {}) {
  post({ type: 'busy', flag: true });
  try {
    if (type === 'saveBusinessSettings') {
      await saveBusinessSettings({ authToken: authState.sessionToken, payload });
      return sendSnapshots('Τα business settings αποθηκεύτηκαν.');
    }
    if (type === 'upsertInsurancePlan') {
      await upsertInsurancePlan({ authToken: authState.sessionToken, payload });
      return sendSnapshots('Το insurance plan αποθηκεύτηκε.');
    }
    if (type === 'upsertExtraService') {
      await upsertExtraService({ authToken: authState.sessionToken, payload });
      return sendSnapshots('Το extra service αποθηκεύτηκε.');
    }
    if (type === 'upsertFeeRule') {
      await upsertFeeRule({ authToken: authState.sessionToken, payload });
      return sendSnapshots('Το fee rule αποθηκεύτηκε.');
    }
    if (type === 'deletePricingItem') {
      await deletePricingItem({ authToken: authState.sessionToken, ...(payload || {}) });
      return sendSnapshots('Το pricing item διαγράφηκε.');
    }
    if (type === 'upsertVehicleCategory') {
      await upsertVehicleCategory({ authToken: authState.sessionToken, payload });
      return sendSnapshots('Η κατηγορία οχήματος αποθηκεύτηκε.');
    }
    if (type === 'deleteVehicleCategory') {
      await deleteVehicleCategory({ authToken: authState.sessionToken, ...(payload || {}) });
      return sendSnapshots('Η κατηγορία οχήματος διαγράφηκε.');
    }
    if (type === 'upsertFleetVehicle') {
      await upsertFleetVehicle({ authToken: authState.sessionToken, payload });
      return sendSnapshots('Το όχημα στόλου αποθηκεύτηκε.');
    }
    if (type === 'deleteFleetVehicle') {
      await deleteFleetVehicle({ authToken: authState.sessionToken, ...(payload || {}) });
      return sendSnapshots('Το όχημα στόλου διαγράφηκε.');
    }
    if (type === 'upsertPricingSeason') {
      await upsertPricingSeason({ authToken: authState.sessionToken, payload });
      return sendSnapshots('Η pricing season αποθηκεύτηκε.');
    }
    if (type === 'deletePricingSeason') {
      await deletePricingSeason({ authToken: authState.sessionToken, ...(payload || {}) });
      return sendSnapshots('Η pricing season διαγράφηκε.');
    }
    if (type === 'upsertCategoryRateRule') {
      await upsertCategoryRateRule({ authToken: authState.sessionToken, payload });
      return sendSnapshots('Ο κανόνας τιμολόγησης αποθηκεύτηκε.');
    }
    if (type === 'deleteCategoryRateRule') {
      await deleteCategoryRateRule({ authToken: authState.sessionToken, ...(payload || {}) });
      return sendSnapshots('Ο κανόνας τιμολόγησης διαγράφηκε.');
    }
    if (type === 'upsertPickupLocation') {
      await upsertPickupLocation({ authToken: authState.sessionToken, payload });
      return sendSnapshots('Η τοποθεσία αποθηκεύτηκε.');
    }
    if (type === 'deletePickupLocation') {
      await deletePickupLocation({ authToken: authState.sessionToken, ...(payload || {}) });
      return sendSnapshots('Η τοποθεσία διαγράφηκε.');
    }
    if (type === 'seedPricingDefaults') {
      const res = await seedPricingDefaults({ authToken: authState.sessionToken, target: payload.target || 'all' });
      post({ type: 'seedPricingResult', result: res });
      const labelMap = { all: 'όλος ο κατάλογος', business: 'business settings', insurance: 'insurance plans', extras: 'extra services', fees: 'fee rules' };
      return sendSnapshots(`Έγινε seed defaults για ${labelMap[String(payload.target || 'all')] || 'τον κατάλογο'}.`);
    }
    if (type === 'resetPricingDefaults') {
      const res = await resetPricingDefaults({ authToken: authState.sessionToken, target: payload.target || 'all' });
      post({ type: 'resetPricingResult', result: res });
      const labelMap = { all: 'όλος ο κατάλογος', business: 'business settings', insurance: 'insurance plans', extras: 'extra services', fees: 'fee rules' };
      return sendSnapshots(`Έγινε reset defaults για ${labelMap[String(payload.target || 'all')] || 'τον κατάλογο'}.`);
    }
    if (type === 'upsertStaffRole') {
      await upsertStaffRole({ sessionToken: authState.sessionToken, payload });
      return sendSnapshots('Ο ρόλος αποθηκεύτηκε.');
    }
    if (type === 'upsertStaffUser') {
      await upsertStaffUser({ sessionToken: authState.sessionToken, payload });
      return sendSnapshots('Ο χρήστης αποθηκεύτηκε.');
    }
    if (type === 'inviteStaffUser') {
      const res = await inviteStaffUser({ sessionToken: authState.sessionToken, payload });
      post({ type: 'staffInviteResult', result: res });
      return sendSnapshots(res.mode === 'invite' ? 'Ο staff user δημιουργήθηκε και εκδόθηκε onboarding access.' : 'Εκδόθηκε νέο προσωρινό onboarding access.');
    }
    if (type === 'deactivateStaffUser') {
      await deactivateStaffUser({ sessionToken: authState.sessionToken, itemId: payload.itemId });
      return sendSnapshots('Ο χρήστης απενεργοποιήθηκε.');
    }
    if (type === 'reactivateStaffUser') {
      await reactivateStaffUser({ sessionToken: authState.sessionToken, itemId: payload.itemId });
      return sendSnapshots('Ο χρήστης ενεργοποιήθηκε ξανά.');
    }
    if (type === 'setStaffPassword') {
      const res = await setStaffPassword({
        sessionToken: authState.sessionToken,
        email: payload.email,
        newPassword: payload.newPassword,
        mustChangePassword: payload.mustChangePassword
      });
      post({
        type: 'staffPasswordResult',
        result: {
          mode: 'set',
          success: !!res?.success,
          email: res?.email || payload.email || '',
          changedAt: new Date().toISOString(),
          mustChangePassword: !!(res?.mustChangePassword ?? payload.mustChangePassword)
        }
      });
      return sendSnapshots('Το password αποθηκεύτηκε.');
    }
    if (type === 'resetStaffPassword') {
      const res = await resetStaffPassword({ sessionToken: authState.sessionToken, email: payload.email });
      post({
        type: 'staffPasswordResult',
        result: {
          mode: 'reset',
          success: !!res?.success,
          email: res?.email || payload.email || '',
          changedAt: new Date().toISOString(),
          mustChangePassword: !!res?.mustChangePassword
        }
      });
      return sendSnapshots('Έγινε reset προσωρινού password.');
    }
    if (type === 'revokeStaffSessions') {
      const res = await revokeStaffSessions({
        sessionToken: authState.sessionToken,
        email: payload.email,
        itemId: payload.itemId,
        exceptCurrent: !!payload.exceptCurrent
      });
      post({ type: 'sessionActionResult', result: res });
      return sendSnapshots(`Ανακλήθηκαν ${Number(res.revoked || 0)} active sessions.`);
    }
    if (type === 'refreshStaffAccess') {
      return sendSnapshots();
    }
    if (type === 'resetBridgeTelemetry') {
      resetBridgeTelemetry();
      sendBridgeTelemetrySnapshot('Καθαρίστηκαν οι bridge telemetry counters.');
      return sendSnapshots('Καθαρίστηκαν οι bridge telemetry counters.');
    }
    if (type === 'logoutBackroom') {
      await logoutBackroom();
      post({ type: 'toast', tone: 'success', message: 'Έγινε αποσύνδεση.' });
      return;
    }
  } catch (err) {
    post({ type: 'busy', flag: false });
    post({ type: 'toast', tone: 'error', message: err?.message || String(err) || 'Αποτυχία αποθήκευσης.' });
  }
}

$w.onReady(async function () {
  authState = await requireBackroomAccess({ area: 'pricing', action: 'View' });
  if (!authState?.ok) return;
  currentUser = authState.email || currentUser;

  try {
    $w(COMP).onMessage(async (event) => {
      const msg = normalizeMessage(event && event.data);
      if (!msg || !msg.type) return;

      if (msg.type === 'pricingAdminReady') {
        await sendSnapshots();
        return;
      }

      if (msg.type === 'requestBridgeTelemetry') {
        sendBridgeTelemetrySnapshot();
        return;
      }

      if (msg.type === 'resize') {
        const height = Math.min(Math.max(Number(msg.height || 0), 1200), 7800);
        if (height) {
          try { $w(COMP).height = height; } catch (_) {}
        }
        return;
      }

      if (msg.type === 'navigate') {
        const route = String(msg.route || '');
        if (route && ROUTES[route]) { wixLocation.to(ROUTES[route]); }
        return;
      }

      if (msg.type === 'menuAction') {
        const action = String(msg.action || '');
        if (action === 'reload') { await sendSnapshots(); return; }
        if (action === 'logout') {
          await logoutBackroom();
          wixLocation.to('/myroom-home');
          return;
        }
      }

      if ([
        'saveBusinessSettings',
        'upsertInsurancePlan',
        'upsertExtraService',
        'upsertFeeRule',
        'deletePricingItem',
        'upsertVehicleCategory',
        'deleteVehicleCategory',
        'upsertFleetVehicle',
        'deleteFleetVehicle',
        'upsertPricingSeason',
        'deletePricingSeason',
        'upsertCategoryRateRule',
        'deleteCategoryRateRule',
        'upsertPickupLocation',
        'deletePickupLocation',
        'seedPricingDefaults',
        'resetPricingDefaults',
        'upsertStaffRole',
        'upsertStaffUser',
        'inviteStaffUser',
        'deactivateStaffUser',
        'reactivateStaffUser',
        'setStaffPassword',
        'resetStaffPassword',
        'revokeStaffSessions',
        'refreshStaffAccess',
        'resetBridgeTelemetry',
        'logoutBackroom'
      ].includes(msg.type)) {
        await handleAction(msg.type, msg.payload || {});
      }
    });
  } catch (err) {
    console.error('Bind pricing admin onMessage failed', err);
  }
});
