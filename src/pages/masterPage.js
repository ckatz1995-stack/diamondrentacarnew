import wixLocation from "wix-location";
import { authentication } from 'wix-members-frontend';
import { clearSessionToken } from 'public/backroomAuth';

const TRUSTED_DOMAIN_SUFFIXES = ['wix.com', 'wixsite.com', 'parastorage.com', 'wixstatic.com'];

$w.onReady(function () {
  if (typeof window === "undefined") return;
  window.addEventListener("message", async (event) => {
    if (!isTrustedMessageOrigin(event?.origin)) return;
    const data = event && event.data;
    if (!data || !data.type) return;
    if (data.type === "wix-booking-nav" && data.path) {
      try { wixLocation.to(String(data.path)); } catch (err) { console.error("Navigation message failed", err); }
      return;
    }
    if (data.type === 'backroomLogout') {
      clearSessionToken();
      try { await authentication.logout(); } catch (_) {}
      wixLocation.to('/myroom-home');
    }
  });
});

function isTrustedMessageOrigin(origin) {
  const raw = String(origin || '').trim().toLowerCase();
  if (!raw) return false;
  try {
    const source = new URL(raw);
    const current = new URL(wixLocation.url);
    const sourceHost = String(source.hostname || '').toLowerCase();
    const currentHost = String(current.hostname || '').toLowerCase();
    if (sourceHost && sourceHost === currentHost) return true;
    return TRUSTED_DOMAIN_SUFFIXES.some((suffix) => sourceHost === suffix || sourceHost.endsWith(`.${suffix}`));
  } catch (_) {
    return false;
  }
}
