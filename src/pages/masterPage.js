import wixLocation from "wix-location";
import { authentication } from 'wix-members-frontend';

$w.onReady(function () {
  if (typeof window === "undefined") return;
  window.addEventListener("message", async (event) => {
    const data = event && event.data;
    if (!data || !data.type) return;
    if (data.type === "wix-booking-nav" && data.path) {
      try { wixLocation.to(String(data.path)); } catch (err) { console.error("Navigation message failed", err); }
      return;
    }
    if (data.type === 'backroomLogout') {
      try { await authentication.logout(); } catch (_) {}
      wixLocation.to('/myroom-home');
    }
  });
});
