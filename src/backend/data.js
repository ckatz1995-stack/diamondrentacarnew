// @ts-check
import { sendTelegramNotification } from 'backend/telegramService';

export async function BookingsNew_afterInsert(item, _) {
  try {
    await sendTelegramNotification(item);
  } catch (err) {
    console.error('[data hook] Telegram notification failed', err);
  }
  return item;
}
