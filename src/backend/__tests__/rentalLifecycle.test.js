import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import * as contract from '../rentalContract.jsw';

// The rental lifecycle: a booking becomes an active rental at checkout and a
// closed one at check-in, with both the booking and its rental record kept in
// step. The document/PDF half of this module is deliberately not covered here —
// it depends on puppeteer and pdfkit, which Velo installs through Wix rather
// than this repo, so those paths cannot run in CI and testing them would mean
// asserting on generated markup rather than on behaviour.

const STAFF = 'staff@example.com';
const VIEWER = 'viewer@example.com';
const PASSWORD = 'correct-horse-battery';
const BOOKING_ID = 'bk-1';

function seed(extra = {}) {
  const passwordSalt = randomHex(16);
  return {
    StaffRoles: [
      { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true },
      // Can read the contract screens but not change them.
      { _id: 'role-viewer', key: 'viewer', label: 'Viewer', active: true, rentalsView: true, specialPermissions: '' },
    ],
    StaffUsers: [
      { _id: 'user-1', email: STAFF, fullName: 'Staff', roleKey: 'admin', active: true },
      { _id: 'user-2', email: VIEWER, fullName: 'Viewer', roleKey: 'viewer', active: true },
    ],
    StaffCredentials: [
      { _id: 'cred-1', email: STAFF, passwordSalt, passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true },
      { _id: 'cred-2', email: VIEWER, passwordSalt, passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true },
    ],
    StaffSessions: [],
    StaffAuditLog: [],
    BookingsNew: [{
      _id: BOOKING_ID,
      bookingNumber: 'RNT-2026-0001',
      status: 'Confirmed',
      rentalState: '',
      customerName: 'A Customer',
      customerEmail: 'customer@example.com',
      pickupDateTime: '2026-01-12T08:00:00.000Z',
      dropoffDateTime: '2026-01-15T08:00:00.000Z',
      categoryId: 'ECO',
      baseCost: 135,
      insuranceCost: 36,
      extrasTotal: 0,
      ageFee: 0,
      nightFee: 0,
      totalPrice: 171,
    }],
    RentalsNew: [],
    FleetNew: [],
    ...extra,
  };
}

let fake;
function install(s = seed()) {
  fake = createFakeWixData(s).install(wixData);
  return fake;
}
async function token(email = STAFF) {
  const { sessionToken } = await loginStaff({ email, password: PASSWORD });
  return sessionToken;
}
const bookingRow = () => fake.rows('BookingsNew').find((b) => b._id === BOOKING_ID);
const rentalRow = () => fake.rows('RentalsNew')[0];

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

// Every export that reads or changes contract data.
const GATED_EXPORTS = [
  ['getContract', { bookingId: BOOKING_ID }],
  ['startRental', { bookingId: BOOKING_ID }],
  ['closeRental', { bookingId: BOOKING_ID }],
  ['saveContract', { bookingId: BOOKING_ID, payload: {}, stage: 'checkout' }],
  ['saveCheckout', { bookingId: BOOKING_ID, payload: {} }],
  ['saveCheckin', { bookingId: BOOKING_ID, payload: {} }],
  ['confirmBookingAnalysis', { bookingId: BOOKING_ID }],
  ['searchContractCustomers', { query: 'a' }],
  ['searchContractCompanies', { query: 'a' }],
  ['getCustomerInsights', { customer: {} }],
  ['getCompanyInsights', { company: {} }],
  ['exportContractDocumentPackage', { bookingId: BOOKING_ID }],
];

describe('auth gating', () => {
  test.each(GATED_EXPORTS)('%s refuses a missing token', async (name, args) => {
    install();
    await expect(contract[name]({ ...args })).rejects.toThrow('AUTH_REQUIRED');
  });

  test.each(GATED_EXPORTS)('%s refuses a bogus token', async (name, args) => {
    install();
    await expect(contract[name]({ authToken: 'made-up', ...args })).rejects.toThrow('AUTH_REQUIRED');
  });

  test('reading a contract is not enough to change one', async () => {
    // Every mutating export gates on rentals/Edit while getContract needs only
    // View. Without a view-only role in the fixtures the two are
    // indistinguishable, and downgrading any of these gates passes silently.
    install();
    const { sessionToken } = await loginStaff({ email: VIEWER, password: PASSWORD });

    await expect(contract.getContract({ authToken: sessionToken, bookingId: BOOKING_ID }))
      .resolves.toMatchObject({ success: true });

    for (const name of ['startRental', 'closeRental', 'confirmBookingAnalysis']) {
      await expect(contract[name]({ authToken: sessionToken, bookingId: BOOKING_ID }))
        .rejects.toThrow('ACCESS_DENIED');
    }
    // getContract materialises the rental draft through ensureRentalForBooking,
    // so a row existing here is the read doing its job. What must not have
    // happened is the state advancing.
    expect(bookingRow().rentalState).toBe('');
    expect(rentalRow().rentalState).toBe('Booking');
  });

  test('nothing is written when the caller is unauthenticated', async () => {
    install();
    for (const [name, args] of GATED_EXPORTS) {
      await contract[name]({ authToken: 'made-up', ...args }).catch(() => {});
    }
    expect(fake.calls.update).toHaveLength(0);
    expect(fake.rows('RentalsNew')).toHaveLength(0);
  });
});

describe('startRental', () => {
  test('moves the booking and its rental record to Active Rental together', async () => {
    // The two must not drift: the fleet calendar reads rentalState off the
    // booking, while the contract screens read it off the rental.
    install();
    const result = await contract.startRental({ authToken: await token(), bookingId: BOOKING_ID, by: 'Dispatcher' });

    expect(result.success).toBe(true);
    expect(bookingRow().rentalState).toBe('Active Rental');
    expect(rentalRow().rentalState).toBe('Active Rental');
  });

  test('creates the rental record when none exists yet', async () => {
    install();
    expect(fake.rows('RentalsNew')).toHaveLength(0);
    await contract.startRental({ authToken: await token(), bookingId: BOOKING_ID });
    expect(fake.rows('RentalsNew')).toHaveLength(1);
    expect(rentalRow().bookingId).toBe(BOOKING_ID);
  });

  test('stamps who checked the vehicle out, and when', async () => {
    install();
    await contract.startRental({ authToken: await token(), bookingId: BOOKING_ID, by: 'Dispatcher' });
    expect(rentalRow().checkoutBy).toBe('Dispatcher');
    expect(rentalRow().checkoutAt).toBeTruthy();
  });

  test('keeps the original checkout time when started twice', async () => {
    // Re-running checkout must not reset the clock on an already-open rental.
    // The clock is advanced between the two calls deliberately: without that,
    // both timestamps land in the same millisecond and compare equal whether or
    // not the code preserves the original, so the assertion would prove nothing.
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-01-12T09:00:00Z'));
      install();
      const t = await token();
      await contract.startRental({ authToken: t, bookingId: BOOKING_ID, by: 'First' });
      const firstCheckout = rentalRow().checkoutAt;

      jest.setSystemTime(new Date('2026-01-12T14:30:00Z'));
      await contract.startRental({ authToken: t, bookingId: BOOKING_ID, by: 'Second' });

      expect(rentalRow().checkoutAt).toEqual(firstCheckout);
      expect(new Date(rentalRow().checkoutAt).toISOString()).toBe('2026-01-12T09:00:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  test('refuses without a booking id, and for an unknown booking', async () => {
    install();
    const t = await token();
    await expect(contract.startRental({ authToken: t })).resolves.toMatchObject({ success: false, message: 'Missing bookingId' });
    await expect(contract.startRental({ authToken: t, bookingId: 'nope' })).resolves.toMatchObject({ success: false, message: 'Booking not found' });
  });
});

describe('closeRental', () => {
  test('moves the booking and rental to Closed Rental together', async () => {
    install();
    const t = await token();
    await contract.startRental({ authToken: t, bookingId: BOOKING_ID });
    const result = await contract.closeRental({ authToken: t, bookingId: BOOKING_ID, by: 'Returner' });

    expect(result.success).toBe(true);
    expect(bookingRow().rentalState).toBe('Closed Rental');
    expect(rentalRow().rentalState).toBe('Closed Rental');
  });

  test('stamps who took the vehicle back, and when', async () => {
    install();
    const t = await token();
    await contract.startRental({ authToken: t, bookingId: BOOKING_ID });
    await contract.closeRental({ authToken: t, bookingId: BOOKING_ID, by: 'Returner' });

    expect(rentalRow().checkinBy).toBe('Returner');
    expect(rentalRow().checkinAt).toBeTruthy();
    expect(rentalRow().checkoutAt).toBeTruthy(); // checkout stamp survives the close
  });

  test('can close a booking that was never formally started', async () => {
    // Walk-up returns happen; closing must not require a prior startRental.
    install();
    const result = await contract.closeRental({ authToken: await token(), bookingId: BOOKING_ID });
    expect(result.success).toBe(true);
    expect(bookingRow().rentalState).toBe('Closed Rental');
  });

  test('refuses without a booking id, and for an unknown booking', async () => {
    install();
    const t = await token();
    await expect(contract.closeRental({ authToken: t })).resolves.toMatchObject({ success: false });
    await expect(contract.closeRental({ authToken: t, bookingId: 'nope' })).resolves.toMatchObject({ success: false, message: 'Booking not found' });
  });
});

describe('getContract', () => {
  test('returns the booking for a valid id', async () => {
    install();
    const result = await contract.getContract({ authToken: await token(), bookingId: BOOKING_ID });
    expect(result.success).toBe(true);
    expect(result.booking.bookingNumber).toBe('RNT-2026-0001');
  });

  test('refuses without a booking id, and for an unknown booking', async () => {
    install();
    const t = await token();
    await expect(contract.getContract({ authToken: t })).resolves.toMatchObject({ success: false, message: 'Missing bookingId' });
    await expect(contract.getContract({ authToken: t, bookingId: 'nope' })).resolves.toMatchObject({ success: false, message: 'Booking not found' });
  });

  test('fills in vehicle details from the fleet record', async () => {
    install(seed({
      BookingsNew: [{ ...seed().BookingsNew[0], assignedVehicle: 'car-a' }],
      FleetNew: [{ _id: 'car-a', plate: 'AAA-1111', model: 'i10', category: 'ECO', mileage: 42000 }],
    }));
    const result = await contract.getContract({ authToken: await token(), bookingId: BOOKING_ID });
    expect(result.booking.assignedVehiclePlate).toBe('AAA-1111');
    expect(result.booking.assignedVehicleModel).toBe('i10');
  });
});

describe('saveCheckout / saveCheckin wrappers', () => {
  test('forward the auth token to saveContract', async () => {
    // Regression: both used to drop authToken, so every call was rejected.
    install();
    const t = await token();
    await expect(contract.saveCheckout({ authToken: t, bookingId: '', payload: {} }))
      .resolves.toMatchObject({ success: false, message: 'Missing bookingId' });
    await expect(contract.saveCheckin({ authToken: t, bookingId: '', payload: {} }))
      .resolves.toMatchObject({ success: false, message: 'Missing bookingId' });
  });
});
