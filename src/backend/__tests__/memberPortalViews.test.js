import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import {
  signIn,
  signOut,
  getCustomerProfile,
  getCustomerBookings,
  getBookingDetail,
} from '../memberPortal.jsw';

// What a signed-in customer actually sees.
//
// memberPortalAuth covers who may call these and whose rows they may reach.
// This covers the decisions made once past that gate: which bookings each
// filter selects, and which of a booking's many near-synonymous fields is the
// one shown. Those were the module's untested branches — it sat at 98%
// statements but 63% branches, because a fallback chain is one statement and
// several decisions.
//
// sanitizeBooking is also the module's data boundary: it is the only thing
// standing between the BookingsNew row and the customer's browser.

const EMAIL = 'customer@example.com';
const REF = 'RNT-2026-0001';
const CUSTOMER_ID = 'cust-1';

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

// signIn matches on bookingNumber *and* customerEmail, so any booking used to
// obtain a session has to keep both. Fixtures that vary those fields would
// otherwise fail to sign in and every assertion would read as a data problem
// rather than the field mapping under test. Every seed therefore keeps one
// untouched booking to sign in with, and the booking under test is a second row
// owned by the same customer.
function signInBooking(overrides = {}) {
  return booking({ _id: 'booking-signin', bookingNumber: REF, ...overrides });
}

function seed(extra = {}) {
  return {
    BookingsNew: [signInBooking()],
    Customers: [{ _id: CUSTOMER_ID, name: 'A Customer', email: EMAIL, phone: '+30 000' }],
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
/** A booking as the customer sees it, fetched through the detail endpoint. */
async function shown(overrides) {
  install(seed({ BookingsNew: [signInBooking(), booking({ ...overrides, _id: 'booking-1', bookingNumber: 'RNT-SUBJECT' })] }));
  const session = await signedIn();
  const res = await getBookingDetail({ bookingId: 'booking-1', ...session });
  return res.booking;
}

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('the booking filters', () => {
  // Four bookings spanning every position relative to now, plus a cancelled
  // one, so each filter has something it must include and something it must
  // leave out.
  // The sign-in booking is one of the four rather than a fifth, so the expected
  // sets stay readable: it *is* the upcoming one.
  const FLEET = [
    booking({ _id: 'b-upcoming', bookingNumber: REF, pickupDateTime: future(48), dropoffDateTime: future(120) }),
    booking({ _id: 'b-active', bookingNumber: 'RNT-2', pickupDateTime: past(24), dropoffDateTime: future(24) }),
    booking({ _id: 'b-past', bookingNumber: 'RNT-3', pickupDateTime: past(120), dropoffDateTime: past(48) }),
    booking({ _id: 'b-cancelled', bookingNumber: 'RNT-4', pickupDateTime: future(72), dropoffDateTime: future(96), status: 'Canceled' }),
    // Cancelled *and* inside the active window, so the active filter's own
    // status guard is what excludes it — the upcoming one cannot reach it.
    booking({ _id: 'b-cancelled-active', bookingNumber: 'RNT-5', pickupDateTime: past(12), dropoffDateTime: future(12), status: 'Canceled' }),
  ];

  const listed = async (filter) => {
    install(seed({ BookingsNew: FLEET }));
    const session = await signedIn();
    const res = await getCustomerBookings({ ...session, filter });
    return res.bookings.map((b) => b._id).sort();
  };

  test('no filter returns everything, cancelled bookings included', async () => {
    expect(await listed(undefined)).toEqual(['b-active', 'b-cancelled', 'b-cancelled-active', 'b-past', 'b-upcoming']);
  });

  test('an unrecognised filter is treated as no filter', async () => {
    expect(await listed('everything')).toEqual(['b-active', 'b-cancelled', 'b-cancelled-active', 'b-past', 'b-upcoming']);
  });

  test('upcoming means pickup still ahead, and not cancelled', async () => {
    expect(await listed('upcoming')).toEqual(['b-upcoming']);
  });

  test('active means picked up but not yet returned', async () => {
    expect(await listed('active')).toEqual(['b-active']);
  });

  test('past means already returned', async () => {
    expect(await listed('past')).toEqual(['b-past']);
  });

  test('a cancelled booking still shows under past once its return date has gone', async () => {
    // Deliberate asymmetry worth knowing: upcoming and active exclude cancelled
    // bookings, past does not. A customer's history keeps what they cancelled.
    install(seed({ BookingsNew: [
      signInBooking(),
      booking({ _id: 'b-old-cancel', bookingNumber: 'RNT-9', pickupDateTime: past(120), dropoffDateTime: past(48), status: 'Canceled' }),
    ] }));
    const session = await signedIn();
    const res = await getCustomerBookings({ ...session, filter: 'past' });
    expect(res.bookings.map((b) => b._id)).toEqual(['b-old-cancel']);
  });

  test('a booking being returned right now counts as active at both edges', async () => {
    // The active window is inclusive on both sides — pickup <= now <= dropoff —
    // so a booking is never in a gap between filters.
    //
    // The clock is frozen for this one. Writing "now" into the fixture and
    // letting the endpoint compute its own `now` a few microseconds later makes
    // the dropoff edge fail intermittently, which is a flaky test rather than a
    // test of inclusivity.
    jest.useFakeTimers({ now: new Date('2026-05-01T12:00:00.000Z') });
    try {
      const instant = new Date().toISOString();
      install(seed({ BookingsNew: [
        signInBooking({ pickupDateTime: instant, dropoffDateTime: instant }),
      ] }));
      const session = await signedIn();
      const res = await getCustomerBookings({ ...session, filter: 'active' });
      expect(res.bookings.map((b) => b._id)).toEqual(['booking-signin']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('and a booking returned one millisecond ago is past, not active', async () => {
    // The other side of the same edge, so "inclusive" is pinned as inclusive
    // rather than as generous.
    jest.useFakeTimers({ now: new Date('2026-05-01T12:00:00.000Z') });
    try {
      const justGone = new Date(Date.now() - 1).toISOString();
      install(seed({ BookingsNew: [
        signInBooking({ pickupDateTime: new Date(Date.now() - 86400000).toISOString(), dropoffDateTime: justGone }),
      ] }));
      const session = await signedIn();
      expect((await getCustomerBookings({ ...session, filter: 'active' })).bookings).toEqual([]);
      expect((await getCustomerBookings({ ...session, filter: 'past' })).bookings.map((b) => b._id)).toEqual(['booking-signin']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the list reports a total alongside the rows', async () => {
    install(seed({ BookingsNew: FLEET }));
    const session = await signedIn();
    const res = await getCustomerBookings({ ...session });
    expect(res.total).toBe(5);
  });

  test('a filter that matches nothing gives an empty list, not an error', async () => {
    // The sign-in booking is upcoming, so a past filter selects none of it.
    install(seed({ BookingsNew: [signInBooking()] }));
    const session = await signedIn();
    const res = await getCustomerBookings({ ...session, filter: 'past' });
    expect(res).toMatchObject({ ok: true, bookings: [], total: 0 });
  });
});

describe('which field the customer is shown', () => {
  test('the vehicle name falls back to the category name', async () => {
    expect((await shown({ vehicleName: 'Kia Picanto', categoryName: 'Economy' })).vehicleName).toBe('Kia Picanto');
    expect((await shown({ categoryName: 'Economy' })).vehicleName).toBe('Economy');
    expect((await shown({})).vehicleName).toBe('');
  });

  test('the total falls back to the final price', async () => {
    // Two names for the same number, written by different parts of the system.
    // Showing 0 because only one of them was set would be a visible wrong price.
    expect((await shown({ totalPrice: 250, finalPrice: 999 })).totalPrice).toBe(250);
    expect((await shown({ totalPrice: undefined, finalPrice: 310 })).totalPrice).toBe(310);
    expect((await shown({ totalPrice: undefined, finalPrice: undefined })).totalPrice).toBe(0);
  });

  test('a genuinely free booking shows as zero, which is the same as unset', async () => {
    // `||` cannot tell 0 from missing, so a zero total and an absent one are
    // indistinguishable here. Harmless today because both display as 0.
    expect((await shown({ totalPrice: 0, finalPrice: 175 })).totalPrice).toBe(175);
  });

  test('the driver name comes from the customer name, then the first name', async () => {
    expect((await shown({ customerName: 'A Customer', firstName: 'Ann' })).driverName).toBe('A Customer');
    expect((await shown({ customerName: undefined, firstName: 'Ann' })).driverName).toBe('Ann');
    expect((await shown({ customerName: undefined, firstName: undefined })).driverName).toBe('');
  });

  test('the driver email comes from customerEmail, then email', async () => {
    expect((await shown({ customerEmail: 'a@example.com', email: 'b@example.com' })).driverEmail).toBe('a@example.com');
    expect((await shown({ customerEmail: undefined, email: 'b@example.com' })).driverEmail).toBe('b@example.com');
  });

  test('the driver phone comes from customerPhone, then phone', async () => {
    expect((await shown({ customerPhone: '+30 111', phone: '+30 222' })).driverPhone).toBe('+30 111');
    expect((await shown({ customerPhone: undefined, phone: '+30 222' })).driverPhone).toBe('+30 222');
    expect((await shown({})).driverPhone).toBe('');
  });

  test('the base price is passed through, defaulting to zero', async () => {
    expect((await shown({ basePrice: 200 })).basePrice).toBe(200);
    expect((await shown({ basePrice: undefined })).basePrice).toBe(0);
  });

  test('extras default to an empty list rather than being absent', async () => {
    expect((await shown({ extras: ['gps', 'seat'] })).extras).toEqual(['gps', 'seat']);
    expect((await shown({})).extras).toEqual([]);
  });

  test('the currency is fixed, not read from the booking', async () => {
    // Every price on the portal is euros. A booking carrying some other currency
    // must not silently relabel the figures.
    expect((await shown({ currency: 'GBP' })).currency).toBe('EUR');
  });

  test('optional text fields come back as empty strings, not undefined', async () => {
    const b = await shown({});
    expect(b.insurance).toBe('');
    expect(b.categoryId).toBe('');
    expect(b.notes).toBe('');
    expect(b.cancelReason).toBe('');
  });

  test('the age and cancellation time come back as null when unset', async () => {
    const b = await shown({});
    expect(b.driverAge).toBeNull();
    expect(b.canceledAt).toBeNull();
  });

  test('nothing beyond the named fields reaches the customer', async () => {
    // The boundary itself. Anything an operator writes onto a booking — internal
    // notes, costs, staff identities — must not travel with it.
    const b = await shown({
      internalMemo: 'customer disputed the fuel charge',
      baseCost: 135,
      assignedVehiclePlate: 'ABC-1234',
      staffNotes: 'do not upgrade',
      financialSnapshot: { settlement: { balance: 250 } },
      chargeLines: [{ code: 'rental_base', amount: 200 }],
    });

    expect(Object.keys(b).sort()).toEqual([
      '_id', 'basePrice', 'bookingNumber', 'cancelReason', 'canceledAt', 'categoryId',
      'currency', 'driverAge', 'driverEmail', 'driverName', 'driverPhone',
      'dropoffDateTime', 'dropoffLocation', 'extras', 'insurance', 'notes',
      'pickupDateTime', 'pickupLocation', 'status', 'totalPrice', 'vehicleName',
    ]);
  });

  test('the same boundary applies to the list, not just the detail view', async () => {
    install(seed({ BookingsNew: [signInBooking({ internalMemo: 'private' })] }));
    const session = await signedIn();
    const res = await getCustomerBookings({ ...session });
    expect(res.bookings[0]).not.toHaveProperty('internalMemo');
  });
});

describe('the customer record behind the session', () => {
  test('signIn prefers the Customers row over the booking', async () => {
    install(seed({
      BookingsNew: [booking({ customerName: 'Stale Name', customerPhone: '+30 999' })],
      Customers: [{ _id: CUSTOMER_ID, name: 'Current Name', email: EMAIL, phone: '+30 000' }],
    }));
    const res = await signIn({ email: EMAIL, bookingRef: REF });
    expect(res.customer).toMatchObject({ _id: CUSTOMER_ID, name: 'Current Name', phone: '+30 000' });
  });

  test('and falls back to the booking when there is no Customers row', async () => {
    install(seed({
      BookingsNew: [booking({ customerName: 'From Booking', customerPhone: '+30 777' })],
      Customers: [],
    }));
    const res = await signIn({ email: EMAIL, bookingRef: REF });
    expect(res.customer).toMatchObject({ name: 'From Booking', phone: '+30 777' });
  });

  test('a booking with no customerId identifies the customer by the booking id', async () => {
    // A walk-in booked without a customer record still gets a working session;
    // the booking's own id becomes the customer id.
    install(seed({
      BookingsNew: [booking({ customerId: undefined, customerName: 'Walk In' })],
      Customers: [],
    }));
    const res = await signIn({ email: EMAIL, bookingRef: REF });
    expect(res.ok).toBe(true);
    expect(res.customerId).toBe('booking-1');
    expect(res.customer._id).toBe('booking-1');
  });

  test('the Customers table is not even consulted for such a booking', async () => {
    // Asserted by watching the queries, not the result: with no customerId the
    // lookup would search for the string "undefined" and find nothing either
    // way, so the returned session looks identical whether the guard is there
    // or not.
    install(seed({ BookingsNew: [booking({ customerId: undefined })], Customers: [] }));
    const collections = [];
    const original = wixData.query;
    wixData.query = (collection) => { collections.push(collection); return original(collection); };
    try {
      const res = await signIn({ email: EMAIL, bookingRef: REF });
      expect(res.ok).toBe(true);
      expect(collections).not.toContain('Customers');
    } finally {
      wixData.query = original;
    }
  });

  test('and it is consulted when there is a customerId', async () => {
    install();
    const collections = [];
    const original = wixData.query;
    wixData.query = (collection) => { collections.push(collection); return original(collection); };
    try {
      await signIn({ email: EMAIL, bookingRef: REF });
      expect(collections).toContain('Customers');
    } finally {
      wixData.query = original;
    }
  });

  test('the customer name reads either spelling on the Customers row', async () => {
    install(seed({ Customers: [{ _id: CUSTOMER_ID, customerName: 'Alt Spelling', customerEmail: EMAIL, customerPhone: '+30 123' }] }));
    const res = await signIn({ email: EMAIL, bookingRef: REF });
    expect(res.customer).toMatchObject({ name: 'Alt Spelling', email: EMAIL, phone: '+30 123' });
  });

  test('the email falls back to the address that was signed in with', async () => {
    install(seed({ Customers: [{ _id: CUSTOMER_ID, name: 'A Customer' }] }));
    const res = await signIn({ email: EMAIL.toUpperCase(), bookingRef: REF });
    expect(res.customer.email).toBe(EMAIL);
  });
});

describe('the profile endpoint', () => {
  test('returns the customer record', async () => {
    install();
    const session = await signedIn();
    const res = await getCustomerProfile(session);
    expect(res).toMatchObject({ ok: true, profile: { _id: CUSTOMER_ID, name: 'A Customer', email: EMAIL, phone: '+30 000' } });
  });

  test('reads either spelling of each field', async () => {
    install(seed({ Customers: [{ _id: CUSTOMER_ID, customerName: 'Alt', customerEmail: 'alt@example.com', customerPhone: '+30 321' }] }));
    const session = await signedIn();
    const res = await getCustomerProfile(session);
    expect(res.profile).toMatchObject({ name: 'Alt', email: 'alt@example.com', phone: '+30 321' });
  });

  test('missing fields come back as empty strings', async () => {
    install(seed({ Customers: [{ _id: CUSTOMER_ID }] }));
    const session = await signedIn();
    const res = await getCustomerProfile(session);
    expect(res.profile).toMatchObject({ name: '', email: '', phone: '' });
  });

  test('reports not_found when the session outlives the customer record', async () => {
    // The session is valid — the row it points at is gone. That is a different
    // answer from unauthorized, and the portal shows a different screen for it.
    install(seed({ BookingsNew: [booking({ customerId: 'ghost' })], Customers: [] }));
    const { customerId, sessionToken } = await signIn({ email: EMAIL, bookingRef: REF });
    const res = await getCustomerProfile({ customerId, sessionToken });
    expect(res).toEqual({ ok: false, error: 'not_found' });
  });

  test('nothing beyond name, email and phone is returned', async () => {
    install(seed({ Customers: [{
      _id: CUSTOMER_ID, name: 'A Customer', email: EMAIL, phone: '+30 000',
      idNumber: 'AB123456', licenseNumber: 'L-777', dateOfBirth: '1988-04-02',
      internalNotes: 'blacklisted once',
    }] }));
    const session = await signedIn();
    const res = await getCustomerProfile(session);
    expect(Object.keys(res.profile).sort()).toEqual(['_id', 'email', 'name', 'phone']);
  });
});

describe('signing out', () => {
  test('removes a session that has already expired', async () => {
    // signOut matches on the hash without checking expiry, so a stale row is
    // still cleaned up rather than left behind forever.
    install();
    const { customerId, sessionToken } = await signedIn();
    const row = fake.rows('PortalSessions')[0];
    await wixData.update('PortalSessions', { ...row, expiresAt: past(1) }, { suppressAuth: true });

    await signOut({ customerId, sessionToken });
    expect(fake.rows('PortalSessions')).toHaveLength(0);
  });

  test('does nothing when either half of the credentials is missing', async () => {
    // The guard is duplicated: findSessionRow refuses the same pair, so
    // removing signOut's own early return changes nothing observable. Kept
    // because the intent is worth stating at the entry point.
    install();
    await signedIn();
    await signOut({ customerId: CUSTOMER_ID });
    await signOut({ sessionToken: 'whatever' });
    await signOut({});
    expect(fake.rows('PortalSessions')).toHaveLength(1);
  });

  test('leaves another customer\'s session alone', async () => {
    install();
    const { sessionToken } = await signedIn();
    await signOut({ customerId: 'someone-else', sessionToken });
    expect(fake.rows('PortalSessions')).toHaveLength(1);
  });

  test('reports success even when the lookup itself fails', async () => {
    install();
    const { customerId, sessionToken } = await signedIn();
    const original = wixData.query;
    wixData.query = () => { throw new Error('PortalSessions is offline'); };
    try {
      await expect(signOut({ customerId, sessionToken })).resolves.toEqual({ ok: true });
    } finally {
      wixData.query = original;
    }
  });
});

describe('a misconfigured session lifetime', () => {
  // PORTAL_SESSION_TTL_HOURS is a module-level import, so the only way to see
  // the `Number.isFinite` guard do anything is to load the module against a
  // different config. Without the guard a non-numeric setting would make the
  // expiry `Invalid Date`, and every comparison against it returns false — so
  // every session would read as unexpired, forever.
  async function signInWithTtl(ttl) {
    jest.resetModules();
    jest.doMock('backend/siteConfig', () => ({ PORTAL_SESSION_TTL_HOURS: ttl }), { virtual: true });
    const freshWixData = (await import('wix-data')).default;
    const portal = await import('../memberPortal.jsw');
    const localFake = createFakeWixData(seed()).install(freshWixData);
    try {
      const res = await portal.signIn({ email: EMAIL, bookingRef: REF });
      const row = localFake.rows('PortalSessions')[0];
      return { res, expiresAt: row && row.expiresAt };
    } finally {
      localFake.restore();
      jest.dontMock('backend/siteConfig');
    }
  }

  test('falls back to eight hours when the setting is not a number', async () => {
    const { res, expiresAt } = await signInWithTtl('soon');
    expect(res.ok).toBe(true);
    const hours = (new Date(expiresAt).getTime() - Date.now()) / 3600000;
    expect(hours).toBeGreaterThan(7.9);
    expect(hours).toBeLessThan(8.1);
  });

  test('and the expiry is a real date, not Invalid Date', async () => {
    const { expiresAt } = await signInWithTtl(undefined);
    expect(Number.isNaN(new Date(expiresAt).getTime())).toBe(false);
  });

  test('a configured number is honoured', async () => {
    const { expiresAt } = await signInWithTtl(24);
    const hours = (new Date(expiresAt).getTime() - Date.now()) / 3600000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
  });
});
