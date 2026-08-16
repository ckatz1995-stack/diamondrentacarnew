import { existsSync } from 'node:fs';
import path from 'node:path';
import * as wixFetch from 'wix-fetch';
import { getSecret } from 'wix-secrets-backend';
import { sendTelegramNotification, testTelegramNotification } from '../telegramService.js';

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

describe('the module is not exposed to the browser', () => {
  test('it is a plain backend file, not a web module', () => {
    // Velo makes every export of a .jsw callable from the browser. Neither
    // export here has a frontend caller — sendTelegramNotification runs from a
    // data hook, testTelegramNotification is a diagnostic — and as a .jsw both
    // were reachable by anyone: enough to post arbitrary text into the office
    // chat, or to learn whether the bot token exists and how long it is.
    //
    // Asserted structurally because nothing else would notice the extension
    // changing back. permissions.json is not the guard here: every one of the
    // 50 methods it lists is anonymous-invokable, so this backend's access
    // control lives in its code, and the only way to keep a function off the
    // public surface is to keep it out of a web module.
    const backend = path.join(__dirname, '..');
    expect(existsSync(path.join(backend, 'telegramService.js'))).toBe(true);
    expect(existsSync(path.join(backend, 'telegramService.jsw'))).toBe(false);
  });
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

  test('a non-numeric total reads as zero rather than "NaN €"', async () => {
    // `Number(x || 0)` guards null and undefined but not a non-numeric value, so
    // this used to send the string "NaN". Third instance of the coercion class
    // toFinite was added for in http-functions.
    await sendTelegramNotification(booking({ totalPrice: 'free' }));
    expect(messageText()).toContain('0.00 €');
    expect(messageText()).not.toContain('NaN');
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

describe('customer text is escaped for Telegram HTML', () => {
  // The message is sent with parse_mode HTML, so <, > and & carry meaning to
  // Telegram's parser. Most of these fields come from the public booking form.
  // Unescaped, a name as ordinary as "Ben & Jerry Ltd" produced a body Telegram
  // rejects — and that rejection is swallowed by the module's own catch, so the
  // office silently never heard about the booking.
  test.each([
    ['an ampersand in the name', { customerName: 'Ben & Jerry Ltd' }, 'Ben &amp; Jerry Ltd'],
    ['angle brackets in the name', { customerName: 'A <b>Customer</b>' }, '&lt;b&gt;'],
    ['markup in the internal memo', { internalMemo: '<script>x</script>' }, '&lt;script&gt;'],
    ['an ampersand in the pickup point', { pickuppoint: 'Hotel B&B' }, 'Hotel B&amp;B'],
    ['markup in the extras field', { extras: '<i>Baby seat</i>' }, '&lt;i&gt;'],
    ['markup in an unparseable date', { pickupDateTime: '<b>soon</b>' }, '&lt;b&gt;soon&lt;/b&gt;'],
  ])('%s is escaped', async (_label, over, expected) => {
    await sendTelegramNotification(booking(over));
    expect(messageText()).toContain(expected);
  });

  test.each([
    ['the name', { customerName: 'A <b>Customer</b>' }],
    ['the memo', { internalMemo: '<script>alert(1)</script>' }],
    ['the flight number', { flightNumber: '<b>A3</b>' }],
    ['the city', { city: '<i>Katerini</i>' }],
    ['the return note', { dropoffInfo: '<u>late</u>' }],
    ['the insurance package', { selectedPackage: '<s>full</s>' }],
    ['the email', { email: '<a href="x">e</a>' }],
  ])('no raw tag from %s survives into the body', async (_label, over) => {
    // Checked as a property rather than field by field: any interpolation added
    // later without escaping shows up here.
    await sendTelegramNotification(booking(over));
    const withoutOwnTags = messageText().replace(/<\/?b>/g, '');
    expect(withoutOwnTags).not.toMatch(/<[a-zA-Z/]/);
  });

  test('the message keeps its own bold tags', async () => {
    // Escaping the values must not escape the formatting the module itself adds.
    await sendTelegramNotification(booking());
    expect(messageText()).toContain('<b>RNT-2026-0001</b>');
    expect(messageText()).toContain('🚗 <b>Νέα Κράτηση!</b>');
  });

  test('an ordinary apostrophe still renders as a character entity Telegram decodes', async () => {
    // O'Brien is common enough that this is worth stating: the shared helper
    // escapes quotes too, and Telegram decodes HTML entities in text.
    await sendTelegramNotification(booking({ customerName: "O'Brien" }));
    expect(messageText()).toContain('O&#39;Brien');
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
