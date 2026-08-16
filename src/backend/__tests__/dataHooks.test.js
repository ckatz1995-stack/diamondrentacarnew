import { sendTelegramNotification } from 'backend/telegramService';
import { BookingsNew_afterInsert } from '../data.js';

// The wix-data hook that fires after a booking is written. It has exactly one
// job beyond firing the notification, and it is the reason this file is tested
// at all: an afterInsert hook must return the item. Returning undefined hands
// wix-data nothing to pass back to the caller, so a notification failure would
// turn into a booking that looks like it did not save.

jest.mock('backend/telegramService', () => ({
  sendTelegramNotification: jest.fn(async () => {}),
}));

const item = () => ({ _id: 'bk-1', bookingNumber: 'RNT-2026-0001', totalPrice: 208 });

beforeEach(() => {
  sendTelegramNotification.mockReset();
  sendTelegramNotification.mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

test('the inserted item is passed straight back', async () => {
  const booking = item();
  await expect(BookingsNew_afterInsert(booking, {})).resolves.toBe(booking);
});

test('the notification is sent the booking that was just written', async () => {
  const booking = item();
  await BookingsNew_afterInsert(booking, {});
  expect(sendTelegramNotification).toHaveBeenCalledWith(booking);
});

test('the item still comes back when the notification throws', async () => {
  // The property the whole hook turns on. A booking is saved; whether the
  // office heard about it is a separate concern and must not rewrite the
  // outcome of the insert.
  const booking = item();
  sendTelegramNotification.mockRejectedValue(new Error('telegram down'));
  await expect(BookingsNew_afterInsert(booking, {})).resolves.toBe(booking);
});

test('a notification failure is logged rather than swallowed silently', async () => {
  sendTelegramNotification.mockRejectedValue(new Error('telegram down'));
  await BookingsNew_afterInsert(item(), {});
  expect(console.error).toHaveBeenCalled();
});

test('the hook waits for the notification rather than firing and forgetting', async () => {
  // Velo tears the request down once the hook resolves, so an un-awaited call
  // can be cut off mid-flight.
  let settled = false;
  sendTelegramNotification.mockImplementation(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    settled = true;
  });
  await BookingsNew_afterInsert(item(), {});
  expect(settled).toBe(true);
});
