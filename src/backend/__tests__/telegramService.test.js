import * as wixFetch from 'wix-fetch';
import { getSecret } from 'wix-secrets-backend';
import { sendTelegramNotification, testTelegramNotification } from '../telegramService.jsw';

// The notification the office gets when a booking comes in. It runs from a
// data hook, off the back of a customer completing a booking, which sets the
// bar for everything here: the notification is allowed to fail, the booking is
// not. Every failure path is asserted to resolve rather than throw.
//
// The message body is also the one place customer-supplied text is sent to an
// external service, so what goes into it is worth reading closely.

jest.mock('wix-secrets-backend', () => ({ getSecret: jest.fn() }));

const TOKEN = 'bot-token-12345';
const CHAT_ID = '1578329343';

function booking(over = {}) {
  return {
    bookingNumber: 'RNT-2026-0001',
    customerName: 'A Customer',
    phone: '+30 6900000000',
    email: 'customer@example.com',
    category: 'ECO',
    pickuppoint: 'Thessaloniki Airport',
    dropoffpoint: 'Thessaloniki Airport',
    pickupDateTime: '2026-03-10T09:30:00.000Z',
    dropoffDateTime: '2026-03-13T09:30:00.000Z',
    billableDays: 3,
    selectedPackage: 'full',
    totalPrice: 208,
    ...over,
  };
}

const sent = () => wixFetch.calls.at(-1);
const messageText = () => sent().body.text;

beforeEach(() => {
  wixFetch.reset();
  getSecret.mockReset();
  getSecret.mockResolvedValue(TOKEN);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a failing notification never breaks the booking', () => {
  // This module is called from BookingsNew_afterInsert. Anything that escapes
  // here lands on a customer who has just paid.
  test('a missing secret is survived, and nothing is sent', async () => {
    getSecret.mockResolvedValue(undefined);
    await expect(sendTelegramNotification(booking())).resolves.toBeUndefined();
    expect(wixFetch.calls).toHaveLength(0);
  });

  test('an empty secret is survived, and nothing is sent', async () => {
    // Worth separating from the missing case: an empty string would otherwise
    // build a URL like /bot/sendMessage and call Telegram with no token.
    getSecret.mockResolvedValue('');
    await expect(sendTelegramNotification(booking())).resolves.toBeUndefined();
    expect(wixFetch.calls).toHaveLength(0);
  });

  test('a secrets vault error is survived', async () => {
    getSecret.mockRejectedValue(new Error('vault unavailable'));
    await expect(sendTelegramNotification(booking())).resolves.toBeUndefined();
    expect(wixFetch.calls).toHaveLength(0);
  });

  test('a network failure is survived', async () => {
    wixFetch.setHandler(async () => { throw new Error('ECONNREFUSED'); });
    await expect(sendTelegramNotification(booking())).resolves.toBeUndefined();
  });

  test('an unreadable response body is survived', async () => {
    wixFetch.setHandler(async () => ({ status: 200, json: async () => { throw new Error('not json'); } }));
    await expect(sendTelegramNotification(booking())).resolves.toBeUndefined();
  });

  test('a Telegram-level rejection is survived and logged', async () => {
    wixFetch.respondWith({ ok: false, description: 'chat not found' }, 400);
    await expect(sendTelegramNotification(booking())).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  test('a booking with no fields at all is survived', async () => {
    await expect(sendTelegramNotification({})).resolves.toBeUndefined();
    expect(wixFetch.calls).toHaveLength(1);
  });

  test('a null booking is survived', async () => {
    await expect(sendTelegramNotification(null)).resolves.toBeUndefined();
  });
});

describe('the request', () => {
  test('goes to the sendMessage endpoint for the configured bot', async () => {
    await sendTelegramNotification(booking());
    expect(sent().url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
  });

  test('a token stored with stray whitespace is trimmed', async () => {
    // A secret pasted into the vault often carries a trailing newline, and an
    // untrimmed one produces a 404 from Telegram rather than an obvious error.
    getSecret.mockResolvedValue(`  ${TOKEN}\n`);
    await sendTelegramNotification(booking());
    expect(sent().url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
  });

  test('is a POST carrying JSON', async () => {
    await sendTelegramNotification(booking());
    expect(sent().options.method).toBe('POST');
    expect(sent().options.headers['Content-Type']).toBe('application/json');
  });

  test('addresses the configured chat and asks for HTML parsing', async () => {
    await sendTelegramNotification(booking());
    expect(sent().body.chat_id).toBe(CHAT_ID);
    expect(sent().body.parse_mode).toBe('HTML');
  });
});

describe('what the message says', () => {
  test('carries the booking number, customer and contact details', async () => {
    await sendTelegramNotification(booking());
    const text = messageText();
    expect(text).toContain('RNT-2026-0001');
    expect(text).toContain('A Customer');
    expect(text).toContain('+30 6900000000');
    expect(text).toContain('customer@example.com');
  });

  test('the total is given to two decimals', async () => {
    await sendTelegramNotification(booking({ totalPrice: 208.5 }));
    expect(messageText()).toContain('208.50 €');
  });

  test('a missing total reads as zero rather than NaN', async () => {
    await sendTelegramNotification(booking({ totalPrice: undefined }));
    expect(messageText()).toContain('0.00 €');
  });

  test('KNOWN DEFECT: a non-numeric total reaches the office as "NaN €"', async () => {
    // `Number(x || 0)` guards null and undefined but not a non-numeric value, so
    // Number('free').toFixed(2) is the string "NaN". Same class as the
    // http-functions bug `toFinite` was added for, and the third instance of it
    // in this backend. Lower reach than that one — totalPrice is computed
    // numerically by createBooking rather than taken from the client — so it
    // needs corrupt stored data to surface, which is why it is pinned here and
    // reported rather than fixed in passing.
    await sendTelegramNotification(booking({ totalPrice: 'free' }));
    expect(messageText()).toContain('NaN €');
  });

  test.each([
    [1, 'ημέρα'],
    [2, 'ημέρες'],
    [3, 'ημέρες'],
  ])('%i day(s) is written as "%s"', async (billableDays, expected) => {
    await sendTelegramNotification(booking({ billableDays }));
    expect(messageText()).toContain(expected);
  });

  test('a booking with no day count reads as one day', async () => {
    await sendTelegramNotification(booking({ billableDays: 0 }));
    expect(messageText()).toContain('ημέρα');
  });

  test('dates are shown in Athens time, not UTC', async () => {
    // The office reads these; a three-hour error at handover is the kind of
    // mistake nobody notices until a customer is standing at the desk.
    await sendTelegramNotification(booking({ pickupDateTime: '2026-07-15T09:30:00.000Z' }));
    expect(messageText()).toContain('12:30'); // 09:30Z is 12:30 in Athens summer time
  });

  test('winter dates use the winter offset', async () => {
    await sendTelegramNotification(booking({ pickupDateTime: '2026-01-15T09:30:00.000Z' }));
    expect(messageText()).toContain('11:30'); // 09:30Z is 11:30 in Athens winter time
  });

  test('an unparseable date is shown as given rather than as "Invalid Date"', async () => {
    await sendTelegramNotification(booking({ pickupDateTime: 'sometime tuesday' }));
    const text = messageText();
    expect(text).toContain('sometime tuesday');
    expect(text).not.toContain('Invalid Date');
  });

  test('a missing date is shown as a dash', async () => {
    await sendTelegramNotification(booking({ pickupDateTime: null }));
    expect(messageText()).toContain('—');
  });

  test('the insurance package is upper-cased', async () => {
    await sendTelegramNotification(booking({ selectedPackage: 'full' }));
    expect(messageText()).toContain('FULL');
  });

  test('the vehicle category name is preferred over the raw code', async () => {
    await sendTelegramNotification(booking({ vehicleCategoryName: 'Economy Hatchback', category: 'ECO' }));
    expect(messageText()).toContain('Economy Hatchback');
  });

  test.each([
    ['extras', { extras: 'Baby seat' }, 'Baby seat'],
    ['a flight number', { flightNumber: 'A3 992' }, 'A3 992'],
    ['a city', { city: 'Katerini' }, 'Katerini'],
    ['return details', { dropoffInfo: 'Late return agreed' }, 'Late return agreed'],
    ['internal comments', { internalMemo: 'Regular customer' }, 'Regular customer'],
  ])('%s appear when present', async (_label, over, expected) => {
    await sendTelegramNotification(booking(over));
    expect(messageText()).toContain(expected);
  });

  test.each([
    ['Extras', 'Extras'],
    ['Πτήση', 'Πτήση'],
    ['Πόλη', 'Πόλη'],
    ['Σχόλια', 'Σχόλια'],
  ])('the %s line is left out when there is nothing to say', async (_label, label) => {
    // Otherwise every notification carries a column of empty headings.
    await sendTelegramNotification(booking());
    expect(messageText()).not.toContain(label);
  });

  test('a whitespace-only city is treated as absent', async () => {
    await sendTelegramNotification(booking({ city: '   ' }));
    expect(messageText()).not.toContain('Πόλη');
  });

  test('originCity is used when city is blank', async () => {
    await sendTelegramNotification(booking({ city: '', originCity: 'Veria' }));
    expect(messageText()).toContain('Veria');
  });
});

describe('customer text reaches Telegram unescaped', () => {
  // NOTE: this pins current behaviour, not desired behaviour. The message is
  // sent with parse_mode HTML, which requires <, > and & to be escaped in text,
  // but the booking fields are interpolated raw. The repo already has an
  // escapeHtml helper in backend/htmlEscape.js that is not used here.
  //
  // customerName and internalMemo originate from the public booking form, so
  // an ordinary name like "Ben & Jerry Ltd" is enough to produce a body Telegram
  // rejects — and the rejection is swallowed by the catch above, so the office
  // simply never hears about that booking.
  test.each([
    ['an ampersand in the name', { customerName: 'Ben & Jerry Ltd' }, '&'],
    ['angle brackets in the name', { customerName: 'A <b>Customer</b>' }, '<b>'],
    ['markup in the internal memo', { internalMemo: '<script>x</script>' }, '<script>'],
  ])('%s is sent through as-is', async (_label, over, raw) => {
    await sendTelegramNotification(booking(over));
    expect(messageText()).toContain(raw);
  });

  test('the escaping the message does apply is only its own bold tags', async () => {
    await sendTelegramNotification(booking());
    expect(messageText()).toContain('<b>RNT-2026-0001</b>');
  });
});

describe('testTelegramNotification', () => {
  test('reports the secret as found and sends a test message', async () => {
    const result = await testTelegramNotification();
    expect(result.secretFound).toBe(true);
    expect(result.apiStatus).toBe(200);
    expect(result.apiResponse).toEqual({ ok: true, result: { message_id: 1 } });
    expect(result.error).toBeNull();
    expect(sent().url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
  });

  test('reports a missing secret without calling Telegram', async () => {
    getSecret.mockResolvedValue(undefined);
    const result = await testTelegramNotification();
    expect(result).toMatchObject({ secretFound: false, tokenLength: 0, apiStatus: null });
    expect(wixFetch.calls).toHaveLength(0);
  });

  test('the reported token length is the trimmed length', async () => {
    getSecret.mockResolvedValue(`  ${TOKEN}  `);
    expect((await testTelegramNotification()).tokenLength).toBe(TOKEN.length);
  });

  test('an error is returned in the result rather than thrown', async () => {
    wixFetch.setHandler(async () => { throw new Error('ECONNREFUSED'); });
    const result = await testTelegramNotification();
    expect(result.error).toBe('ECONNREFUSED');
    expect(result.secretFound).toBe(true);
  });

  test('a non-200 response is reported rather than treated as success', async () => {
    wixFetch.respondWith({ ok: false, description: 'Unauthorized' }, 401);
    const result = await testTelegramNotification();
    expect(result.apiStatus).toBe(401);
    expect(result.apiResponse).toMatchObject({ ok: false });
  });
});
