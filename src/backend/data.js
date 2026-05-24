import { sendTelegramNotification } from 'backend/telegramService.jsw';

export function BookingsNew_afterInsert(item, context) {
  sendTelegramNotification(item).catch(() => {});
  return item;
}
