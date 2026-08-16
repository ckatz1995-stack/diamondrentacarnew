// @ts-check
// A plain .js backend module on purpose, not a .jsw. Web modules are callable
// from the browser, and neither export here has a frontend caller:
// sendTelegramNotification runs from the BookingsNew afterInsert hook, and
// testTelegramNotification is a diagnostic. As a .jsw both were reachable by
// anyone — enough to post arbitrary text into the office chat, or to learn
// whether the bot token exists and how long it is.
import { fetch } from 'wix-fetch';
import { getSecret } from 'wix-secrets-backend';
import { escapeHtml } from 'backend/htmlEscape';

const TELEGRAM_CHAT_ID = '1578329343';

// The message is sent with parse_mode HTML, so every interpolated value has to
// be escaped: <, > and & carry meaning to Telegram's parser. Most of these
// fields come from the public booking form, and a name as ordinary as
// "Ben & Jerry Ltd" was enough to produce a body Telegram rejects — which the
// catch below then swallowed, so the office never heard about that booking.
const esc = escapeHtml;

// `Number(x || 0)` catches null and undefined but not a non-numeric value, and
// NaN.toFixed(2) is the string "NaN". The office should see a figure.
function toFinite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatDT(value) {
  if (!value) return '—';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('el-GR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Athens' });
  } catch (_) { return String(value); }
}

export async function testTelegramNotification() {
  const result = { secretFound: false, tokenLength: 0, apiStatus: null, apiResponse: null, error: null };
  try {
    const token = await getSecret('TELEGRAM_BOT_TOKEN');
    result.secretFound = !!token;
    result.tokenLength = token ? String(token).trim().length : 0;
    if (!token) return result;
    const res = await fetch(`https://api.telegram.org/bot${String(token).trim()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: '✅ Test από Diamond Rent A Car — σύνδεση Telegram επιβεβαιώθηκε!' })
    });
    result.apiStatus = res.status;
    result.apiResponse = await res.json();
  } catch (err) {
    result.error = err.message || String(err);
  }
  return result;
}

export async function sendTelegramNotification(booking) {
  try {
    const token = await getSecret('TELEGRAM_BOT_TOKEN');
    if (!token) return;
    const lines = [
      '🚗 <b>Νέα Κράτηση!</b>',
      '',
      `📋 <b>${esc(booking.bookingNumber || '—')}</b>`,
      `👤 ${esc(booking.customerName || '—')}  📞 ${esc(booking.phone || '—')}`,
      `📧 ${esc(booking.email || '—')}`,
      '',
      `🚙 ${esc(booking.vehicleCategoryName || booking.category || '—')}`,
      `📍 Παραλαβή: ${esc(booking.pickuppoint || '—')}`,
      `   ${esc(formatDT(booking.pickupDateTime))}`,
      `📍 Επιστροφή: ${esc(booking.dropoffpoint || '—')}`,
      `   ${esc(formatDT(booking.dropoffDateTime))}`,
      `📅 ${esc(booking.billableDays || 1)} ημέρ${(booking.billableDays || 1) === 1 ? 'α' : 'ες'}`,
      '',
      `🛡️ Ασφάλιση: ${esc(String(booking.selectedPackage || '—').toUpperCase())}`,
    ];
    if (booking.extras) lines.push(`➕ Extras: ${esc(booking.extras)}`);
    const originCity = String(booking.city || booking.originCity || '').trim();
    if (originCity) lines.push(`🏙️ Πόλη: ${esc(originCity)}`);
    if (booking.flightNumber) lines.push(`✈️ Πτήση: ${esc(booking.flightNumber)}`);
    if (booking.dropoffInfo) lines.push(`🔄 Επιστροφή: ${esc(booking.dropoffInfo)}`);
    lines.push('', `💶 Σύνολο: <b>${toFinite(booking.totalPrice).toFixed(2)} €</b>`);
    const comments = String(booking.internalMemo || '').trim();
    if (comments) lines.push(`💬 Σχόλια: ${esc(comments)}`);
    const res = await fetch(`https://api.telegram.org/bot${String(token).trim()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: lines.join('\n'), parse_mode: 'HTML' })
    });
    const json = await res.json();
    if (!json.ok) {
      console.error('[telegram] sendMessage failed', JSON.stringify(json));
    } else {
      console.log('[telegram] sendMessage ok, message_id:', json.result?.message_id);
    }
  } catch (err) {
    console.error('[telegram] sendTelegramNotification error', err?.message || String(err));
  }
}
