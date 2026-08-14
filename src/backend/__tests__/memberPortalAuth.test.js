import { createHash } from 'crypto';
import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import {
  signIn,
  signOut,
  getCustomerProfile,
  getCustomerBookings,
  getBookingDetail,
  updateBooking,
  cancelBooking,
} from '../memberPortal.jsw';

const EMAIL = 'customer@example.com';
const REF = 'RNT-2026-0001';
const CUSTOMER_ID = 'cust-1';

// A second customer, used to prove one customer cannot reach another's data.
const OTHER_EMAIL = 'someone.else@example.com';
const OTHER_REF = 'RNT-2026-0002';
const OTHER_CUSTOMER_ID = 'cust-2';

const future = (hours) => new Date(Date.now() + hours * 3600 * 1000).toISOString();
const past = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();

function booking(overrides = {}) {
  return {
    _id: 'booking-1',
    bookingNumber: REF,
    customerId: CUSTOMER_ID,
    customerEmail: EMAIL,
    customerName: 'A Customer',
    status: 'Confirmed',
    pickupDateTime: future(48),
    dropoffDateTime: future(120),
    pickupLocation: 'Thessaloniki Airport',
    dropoffLocation: 'Thessaloniki Airport',
    totalPrice: 250,
    basePrice: 200,
    notes: '',
    ...overrides,
  };
}

function seed(extra = {}) {
  return {
    BookingsNew: [
      booking(),
      booking({
        _id: 'booking-2',
        bookingNumber: OTHER_REF,
        customerId: OTHER_CUSTOMER_ID,
        customerEmail: OTHER_EMAIL,
        customerName: 'Someone Else',
        totalPrice: 999,
      }),
    ],
    Customers: [
      { _id: CUSTOMER_ID, name: 'A Customer', email: EMAIL, phone: '+30 000' },
      { _id: OTHER_CUSTOMER_ID, name: 'Someone Else', email: OTHER_EMAIL, phone: '+30 111' },
    ],
    PortalSessions: [],
    ...extra,
  };
}

let fake;
function install(seedData = seed()) {
  fake = createFakeWixData(seedData).install(wixData);
  return fake;
}

async function signedIn() {
  const result = await signIn({ email: EMAIL, bookingRef: REF });
  return { customerId: result.customerId, sessionToken: result.sessionToken };
}

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('signIn', () => {
  test('signs in with a matching email and booking reference', async () => {
    install();
    const result = await signIn({ email: EMAIL, bookingRef: REF });
    expect(result.ok).toBe(true);
    expect(result.customerId).toBe(CUSTOMER_ID);
    expect(typeof result.sessionToken).toBe('string');
    expect(result.customer.email).toBe(EMAIL);
  });

  test('normalises email case and booking-reference case', async () => {
    install();
    const result = await signIn({ email: 'CUSTOMER@Example.COM', bookingRef: 'rnt-2026-0001' });
    expect(result.ok).toBe(true);
  });

  test('rejects a booking reference that does not exist', async () => {
    install();
    await expect(signIn({ email: EMAIL, bookingRef: 'RNT-9999-9999' }))
      .resolves.toMatchObject({ ok: false, error: 'not_found' });
  });

  test('rejects a real reference paired with the wrong email', async () => {
    // The important one: knowing a booking number must not be enough.
    install();
    await expect(signIn({ email: 'attacker@example.com', bookingRef: REF }))
      .resolves.toMatchObject({ ok: false, error: 'not_found' });
  });

  test('uses the same error for a wrong email as for an unknown reference', async () => {
    // Otherwise the response distinguishes "this booking exists" from "it does not",
    // turning sign-in into a booking-number oracle.
    install();
    const wrongEmail = await signIn({ email: 'attacker@example.com', bookingRef: REF });
    const unknownRef = await signIn({ email: EMAIL, bookingRef: 'RNT-9999-9999' });
    expect(wrongEmail.error).toBe(unknownRef.error);
  });

  test('requires both fields', async () => {
    install();
    await expect(signIn({ email: EMAIL })).resolves.toMatchObject({ ok: false, error: 'missing_fields' });
    await expect(signIn({ bookingRef: REF })).resolves.toMatchObject({ ok: false, error: 'missing_fields' });
    await expect(signIn({})).resolves.toMatchObject({ ok: false, error: 'missing_fields' });
  });

  test('creates no session when sign-in fails', async () => {
    install();
    await signIn({ email: 'attacker@example.com', bookingRef: REF });
    expect(fake.rows('PortalSessions')).toHaveLength(0);
  });

  test('issues a distinct, unguessable token per sign-in', async () => {
    install();
    const a = await signIn({ email: EMAIL, bookingRef: REF });
    const b = await signIn({ email: EMAIL, bookingRef: REF });
    expect(a.sessionToken).not.toBe(b.sessionToken);
    // crypto.randomBytes(24) hex — 48 chars of real entropy, not Math.random.
    expect(a.sessionToken).toMatch(/^[0-9a-f]{48}$/);
  });

  test('gives the session a bounded lifetime', async () => {
    install();
    await signIn({ email: EMAIL, bookingRef: REF });
    const [session] = fake.rows('PortalSessions');
    const ttlMs = new Date(session.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(8 * 3600 * 1000 + 1000);
  });

  test('stores only a hash of the token, never the token itself', async () => {
    // A leaked PortalSessions table must not yield anything presentable as a session.
    install();
    const { sessionToken } = await signIn({ email: EMAIL, bookingRef: REF });

    const [session] = fake.rows('PortalSessions');
    expect(session.tokenHash).toBe(createHash('sha256').update(sessionToken).digest('hex'));
    expect(session).not.toHaveProperty('sessionToken');
    expect(JSON.stringify(session)).not.toContain(sessionToken);
  });

  test('a token stolen from the stored hash cannot be replayed', async () => {
    // Presenting the stored hash as if it were the token must not authenticate.
    install();
    const { customerId, sessionToken } = await signIn({ email: EMAIL, bookingRef: REF });
    const [session] = fake.rows('PortalSessions');

    expect(session.tokenHash).not.toBe(sessionToken);
    await expect(getCustomerProfile({ customerId, sessionToken: session.tokenHash }))
      .resolves.toMatchObject({ ok: false, error: 'unauthorized' });
  });
});

describe('session enforcement', () => {
  test('every authenticated call rejects a missing or bogus token', async () => {
    install();
    const bad = { customerId: CUSTOMER_ID, sessionToken: 'made-up-token' };
    await expect(getCustomerProfile(bad)).resolves.toMatchObject({ ok: false, error: 'unauthorized' });
    await expect(getCustomerBookings(bad)).resolves.toMatchObject({ ok: false, error: 'unauthorized' });
    await expect(getBookingDetail({ ...bad, bookingId: 'booking-1' })).resolves.toMatchObject({ ok: false, error: 'unauthorized' });
    await expect(updateBooking({ ...bad, bookingId: 'booking-1', changes: { notes: 'x' } })).resolves.toMatchObject({ ok: false, error: 'unauthorized' });
    await expect(cancelBooking({ ...bad, bookingId: 'booking-1' })).resolves.toMatchObject({ ok: false, error: 'unauthorized' });
  });

  test('rejects an expired session', async () => {
    install();
    const session = await signedIn();
    const [row] = fake.rows('PortalSessions');
    await wixData.update('PortalSessions', { ...row, expiresAt: past(1) });
    await expect(getCustomerProfile(session)).resolves.toMatchObject({ ok: false, error: 'unauthorized' });
  });

  test('rejects a valid token presented with a different customerId', async () => {
    // The token alone must not be enough; it is bound to its customer.
    install();
    const session = await signedIn();
    await expect(getCustomerProfile({ customerId: OTHER_CUSTOMER_ID, sessionToken: session.sessionToken }))
      .resolves.toMatchObject({ ok: false, error: 'unauthorized' });
  });

  test('signOut invalidates the session', async () => {
    install();
    const session = await signedIn();
    expect((await getCustomerProfile(session)).ok).toBe(true);

    await signOut(session);

    expect(fake.rows('PortalSessions')).toHaveLength(0);
    await expect(getCustomerProfile(session)).resolves.toMatchObject({ ok: false, error: 'unauthorized' });
  });

  test('signOut succeeds quietly for an unknown token', async () => {
    install();
    await expect(signOut({ customerId: CUSTOMER_ID, sessionToken: 'made-up' })).resolves.toMatchObject({ ok: true });
    await expect(signOut({})).resolves.toMatchObject({ ok: true });
  });
});

describe('ownership scoping', () => {
  test('a signed-in customer cannot read another customer\'s booking', async () => {
    install();
    const session = await signedIn();
    await expect(getBookingDetail({ ...session, bookingId: 'booking-2' }))
      .resolves.toMatchObject({ ok: false, error: 'not_found' });
  });

  test('a signed-in customer cannot update another customer\'s booking', async () => {
    install();
    const session = await signedIn();
    const result = await updateBooking({ ...session, bookingId: 'booking-2', changes: { notes: 'hijacked' } });
    expect(result).toMatchObject({ ok: false, error: 'not_found' });

    const untouched = fake.rows('BookingsNew').find((b) => b._id === 'booking-2');
    expect(untouched.notes).toBe('');
  });

  test('a signed-in customer cannot cancel another customer\'s booking', async () => {
    install();
    const session = await signedIn();
    const result = await cancelBooking({ ...session, bookingId: 'booking-2', reason: 'nope' });
    expect(result).toMatchObject({ ok: false, error: 'not_found' });

    const untouched = fake.rows('BookingsNew').find((b) => b._id === 'booking-2');
    expect(untouched.status).toBe('Confirmed');
  });

  test('listing bookings returns only the signed-in customer\'s own', async () => {
    install();
    const session = await signedIn();
    const result = await getCustomerBookings(session);
    expect(result.ok).toBe(true);
    expect(result.bookings.every((b) => b.bookingNumber === REF)).toBe(true);
  });
});

describe('updateBooking', () => {
  test('applies the allowed fields', async () => {
    install();
    const session = await signedIn();
    const result = await updateBooking({ ...session, bookingId: 'booking-1', changes: { notes: 'late arrival' } });
    expect(result.ok).toBe(true);
    expect(result.booking.notes).toBe('late arrival');
  });

  test('ignores fields outside the allowlist, so a customer cannot reprice a booking', async () => {
    // The allowlist is what stops the client from setting its own totalPrice or status.
    install();
    const session = await signedIn();
    await updateBooking({
      ...session,
      bookingId: 'booking-1',
      changes: { notes: 'ok', totalPrice: 1, basePrice: 1, status: 'Confirmed', customerId: OTHER_CUSTOMER_ID },
    });

    const stored = fake.rows('BookingsNew').find((b) => b._id === 'booking-1');
    expect(stored.totalPrice).toBe(250);
    expect(stored.basePrice).toBe(200);
    expect(stored.customerId).toBe(CUSTOMER_ID);
  });

  test('rejects an update with no recognised fields', async () => {
    install();
    const session = await signedIn();
    await expect(updateBooking({ ...session, bookingId: 'booking-1', changes: { totalPrice: 1 } }))
      .resolves.toMatchObject({ ok: false, error: 'no_changes' });
    await expect(updateBooking({ ...session, bookingId: 'booking-1', changes: {} }))
      .resolves.toMatchObject({ ok: false, error: 'no_changes' });
  });

  test('refuses to modify a booking whose pickup has passed', async () => {
    install(seed({
      BookingsNew: [booking({ pickupDateTime: past(2), dropoffDateTime: future(24) })],
    }));
    const session = await signedIn();
    await expect(updateBooking({ ...session, bookingId: 'booking-1', changes: { notes: 'too late' } }))
      .resolves.toMatchObject({ ok: false, error: 'pickup_passed' });
  });

  test('refuses to modify an already-cancelled booking', async () => {
    install(seed({ BookingsNew: [booking({ status: 'Canceled' })] }));
    const session = await signedIn();
    await expect(updateBooking({ ...session, bookingId: 'booking-1', changes: { notes: 'x' } }))
      .resolves.toMatchObject({ ok: false, error: 'already_canceled' });
  });
});

describe('cancelBooking', () => {
  test('cancels an upcoming booking and records the reason', async () => {
    install();
    const session = await signedIn();
    const result = await cancelBooking({ ...session, bookingId: 'booking-1', reason: 'plans changed' });
    expect(result.ok).toBe(true);

    const stored = fake.rows('BookingsNew').find((b) => b._id === 'booking-1');
    expect(stored.status).toBe('Canceled');
    expect(stored.cancelReason).toBe('plans changed');
    expect(stored.canceledAt).toBeTruthy();
  });

  test('defaults the reason when none is given', async () => {
    install();
    const session = await signedIn();
    await cancelBooking({ ...session, bookingId: 'booking-1' });
    const stored = fake.rows('BookingsNew').find((b) => b._id === 'booking-1');
    expect(stored.cancelReason).toBe('Customer request');
  });

  test('refuses to cancel twice', async () => {
    install();
    const session = await signedIn();
    await cancelBooking({ ...session, bookingId: 'booking-1' });
    await expect(cancelBooking({ ...session, bookingId: 'booking-1' }))
      .resolves.toMatchObject({ ok: false, error: 'already_canceled' });
  });

  test('refuses to cancel once pickup has passed', async () => {
    install(seed({ BookingsNew: [booking({ pickupDateTime: past(1), dropoffDateTime: future(24) })] }));
    const session = await signedIn();
    await expect(cancelBooking({ ...session, bookingId: 'booking-1' }))
      .resolves.toMatchObject({ ok: false, error: 'pickup_passed' });
  });
});

describe('sanitizeBooking', () => {
  test('returns only the whitelisted customer-facing fields', async () => {
    install(seed({
      BookingsNew: [booking({ internalStaffNotes: 'do not show', costPrice: 120, netAmount: 201.61 })],
    }));
    const session = await signedIn();
    const { booking: sanitized } = await getBookingDetail({ ...session, bookingId: 'booking-1' });

    expect(sanitized).not.toHaveProperty('internalStaffNotes');
    expect(sanitized).not.toHaveProperty('costPrice');
    expect(sanitized).not.toHaveProperty('netAmount');
    expect(sanitized.bookingNumber).toBe(REF);
  });
});
