import { sendTelegramNotification } from 'backend/telegramService.jsw';

export async function BookingsNew_afterInsert(item, context) {
  try {
    await sendTelegramNotification(item);
  } catch (err) {
    console.error('[data hook] Telegram notification failed', err);
  }
  return item;
}
