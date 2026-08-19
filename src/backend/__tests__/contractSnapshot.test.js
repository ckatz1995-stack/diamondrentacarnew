import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import {
  getContract,
  saveContract,
  confirmBookingAnalysis,
  getCustomerInsights,
  getCompanyInsights,
} from '../rentalContract.jsw';

// The last uncovered corners of rentalContract: the money ledger that turns a
// list of transactions into held/active/received totals, the confirm-and-assign
// endpoint, and the vehicle fields a save mirrors onto both records.

const PASSWORD = 'correct-horse-battery';
const ADMIN = 'admin@example.com';
const BOOKING_ID = 'bk-1';

const booking = (extra = {}) => ({
  _id: BOOKING_ID,
  bookingNumber: 'RNT-2026-0001',
  status: 'Confirmed',
  customerName: 'A Customer',
  email: 'customer@example.com',
  phone: '2101234567',
  pickupDateTime: '2026-03-10T08:00:00.000Z',
  dropoffDateTime: '2026-03-13T08:00:00.000Z',
  categoryId: 'ECO',
  baseCost: 135, insuranceCost: 36, extrasTotal: 0, ageFee: 0, nightFee: 0, totalPrice: 171,
  ...extra,
});

function seed({ bookingRow = booking(), rentals = [], fleetRows = [], bookings = [] } = {}) {
  const salt = randomHex(16);
  return {
    StaffRoles: [{ _id: 'role-admin', key: 'admin', label: 'Administrator', active: true }],
    StaffUsers: [{ _id: 'u-1', email: ADMIN, fullName: 'The Admin', roleKey: 'admin', active: true }],
    StaffCredentials: [{
      _id: 'c-1', email: ADMIN, passwordSalt: salt,
      passwordHash: derivePasswordHash(PASSWORD, salt), active: true,
    }],
    StaffSessions: [],
    StaffAuditLog: [],
    BookingsNew: [bookingRow, ...bookings],
    RentalsNew: rentals,
    FleetNew: fleetRows,
    VehiclesNew: [],
    Customers: [],
    Companies: [],
  };
}

let fake;
const install = (options) => { fake = createFakeWixData(seed(options)).install(wixData); return fake; };
const token = async () => (await loginStaff({ email: ADMIN, password: PASSWORD })).sessionToken;
const contract = async (options) => {
  install(options);
  return getContract({ authToken: await token(), bookingId: BOOKING_ID });
};
const bookingRow = () => fake.rows('BookingsNew').find((b) => b._id === BOOKING_ID);
const rentalRow = () => fake.rows('RentalsNew').find((r) => r.bookingId === BOOKING_ID);

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('the money ledger', () => {
  const withTransactions = async (financialTransactions) => {
    const res = await contract({
      rentals: [{ _id: 'r-1', bookingId: BOOKING_ID, financialTransactions }],
    });
    expect(res.success).toBe(true);
    return res.rental.financialSnapshot.ledger;
  };

  test('a payment is counted as received and moves the rental flow up', async () => {
    const ledger = await withTransactions([{ type: 'payment', amount: 100 }]);

    expect(ledger).toMatchObject({ transactions: 1, paymentsReceived: 100, rentalFlow: 100, refunds: 0 });
  });

  test('a refund is counted separately and moves the rental flow back down', async () => {
    const ledger = await withTransactions([
      { type: 'payment', amount: 100 },
      { type: 'refund', amount: 40 },
    ]);

    expect(ledger).toMatchObject({ paymentsReceived: 100, refunds: 40, rentalFlow: 60 });
  });

  test('a guarantee hold is tracked apart from the money actually taken', async () => {
    // A guarantee is held, not received: counting it as a payment would make a
    // rental look settled when nothing has been charged.
    const ledger = await withTransactions([{ type: 'guarantee_hold', amount: 300 }]);

    expect(ledger).toMatchObject({ guaranteeHeld: 300, paymentsReceived: 0, rentalFlow: 0 });
  });

  test('releasing a guarantee brings the held amount back down', async () => {
    const ledger = await withTransactions([
      { type: 'guarantee_hold', amount: 300 },
      { type: 'guarantee_refund', amount: 120 },
    ]);

    expect(ledger.guaranteeHeld).toBe(180);
  });

  test('a pre-authorisation is tracked apart again, and voiding it releases it', async () => {
    const ledger = await withTransactions([
      { type: 'preauth_hold', amount: 500 },
      { type: 'preauth_void', amount: 200 },
    ]);

    expect(ledger).toMatchObject({ preauthActive: 300, guaranteeHeld: 0, paymentsReceived: 0 });
  });

  test('the three streams do not leak into each other', async () => {
    const ledger = await withTransactions([
      { type: 'payment', amount: 100 },
      { type: 'guarantee_hold', amount: 300 },
      { type: 'preauth_hold', amount: 500 },
    ]);

    expect(ledger).toMatchObject({
      paymentsReceived: 100, rentalFlow: 100, guaranteeHeld: 300, preauthActive: 500,
    });
  });

  test.each([
    ['a guarantee released without ever being held', [{ type: 'guarantee_refund', amount: 50 }], 'guaranteeHeld'],
    ['a pre-authorisation voided without ever being held', [{ type: 'preauth_void', amount: 50 }], 'preauthActive'],
  ])('%s never reads as a negative balance', async (_label, transactions, field) => {
    // Floored at zero on the way out: a negative "held" figure would be
    // meaningless on the screen and worse in a total.
    const ledger = await withTransactions(transactions);

    expect(ledger[field]).toBe(0);
  });

  test('the sign of the amount does not matter — the type decides the direction', async () => {
    const ledger = await withTransactions([
      { type: 'payment', amount: -100 },
      { type: 'refund', amount: -40 },
    ]);

    expect(ledger).toMatchObject({ paymentsReceived: 100, refunds: 40, rentalFlow: 60 });
  });

  test.each([
    ['a zero amount', { type: 'payment', amount: 0 }],
    ['an unparseable amount', { type: 'payment', amount: 'a hundred' }],
    ['no amount at all', { type: 'payment' }],
  ])('%s is ignored rather than counted', async (_label, tx) => {
    const ledger = await withTransactions([tx]);

    expect(ledger.paymentsReceived).toBe(0);
    // Still counted as a row: the ledger says how many entries exist, and
    // hiding one would make the screen disagree with the list beneath it.
    expect(ledger.transactions).toBe(1);
  });

  test('an unrecognised transaction type touches none of the totals', async () => {
    const ledger = await withTransactions([{ type: 'tip', amount: 20 }]);

    expect(ledger).toMatchObject({
      paymentsReceived: 0, refunds: 0, rentalFlow: 0, guaranteeHeld: 0, preauthActive: 0,
    });
  });

  test('a rental with no transactions at all still reports a ledger', async () => {
    const res = await contract({ rentals: [{ _id: 'r-1', bookingId: BOOKING_ID }] });

    expect(res.rental.financialSnapshot.ledger).toMatchObject({ transactions: 0, paymentsReceived: 0 });
  });

  test('amounts are rounded to the cent as they accumulate', async () => {
    const ledger = await withTransactions([
      { type: 'payment', amount: 0.1 },
      { type: 'payment', amount: 0.2 },
    ]);

    expect(ledger.paymentsReceived).toBe(0.3);
  });
});

describe('what a fresh rental inherits from its booking', () => {
  test('the vehicle labels and stations are carried across', async () => {
    const res = await contract({
      bookingRow: booking({
        assignedVehicle: 'f-1',
        assignedVehicleLabel: 'AAA-1 - Fiat Panda',
        assignedVehicleStationCode: 'SKG',
        assignedVehicleStationLabel: 'Thessaloniki',
      }),
      rentals: [{ _id: 'r-1', bookingId: BOOKING_ID }],
    });

    expect(res.rental).toMatchObject({
      assignedVehicleLabel: 'AAA-1 - Fiat Panda',
      assignedVehicleStationCode: 'SKG',
      assignedVehicleStationLabel: 'Thessaloniki',
    });
  });

  test('a value already on the rental is not overwritten by the booking', async () => {
    const res = await contract({
      bookingRow: booking({ assignedVehicleLabel: 'AAA-1 - Fiat Panda' }),
      rentals: [{ _id: 'r-1', bookingId: BOOKING_ID, assignedVehicleLabel: 'BBB-2 - VW Polo' }],
    });

    expect(res.rental.assignedVehicleLabel).toBe('BBB-2 - VW Polo');
  });

  test('the charge lines are derived when the rental has none', async () => {
    const res = await contract({ rentals: [{ _id: 'r-1', bookingId: BOOKING_ID }] });

    expect(res.rental.chargeLines.length).toBeGreaterThan(0);
    expect(res.rental.charges).toEqual(expect.any(Object));
  });

  test('an empty charge-line list is refilled rather than left empty', async () => {
    const res = await contract({ rentals: [{ _id: 'r-1', bookingId: BOOKING_ID, chargeLines: [] }] });

    expect(res.rental.chargeLines.length).toBeGreaterThan(0);
  });

  test('the transactions fall back to the booking’s own list', async () => {
    const res = await contract({
      bookingRow: booking({ financialTransactions: [{ type: 'payment', amount: 50 }] }),
      rentals: [{ _id: 'r-1', bookingId: BOOKING_ID }],
    });

    expect(res.rental.financialSnapshot.ledger).toMatchObject({ transactions: 1, paymentsReceived: 50 });
  });
});

describe('getContract when the read itself fails', () => {
  test('a booking that cannot be fetched is reported rather than thrown', async () => {
    install();
    const authToken = await token();
    const original = wixData.get;
    wixData.get = (collection, ...rest) => (
      collection === 'BookingsNew'
        ? Promise.reject(new Error('collection missing'))
        : original.call(wixData, collection, ...rest)
    );
    try {
      expect(await getContract({ authToken, bookingId: BOOKING_ID }))
        .toMatchObject({ success: false, message: 'collection missing' });
    } finally {
      wixData.get = original;
    }
  });

  test('no booking id is refused before any read', async () => {
    install();

    expect(await getContract({ authToken: await token(), bookingId: '' }))
      .toMatchObject({ success: false, message: 'Missing bookingId' });
  });

  test('a booking id that matches nothing says so', async () => {
    install();

    expect(await getContract({ authToken: await token(), bookingId: 'bk-nope' }))
      .toMatchObject({ success: false });
  });
});

describe('confirming a booking and assigning a vehicle', () => {
  const fleetRow = (extra = {}) => ({
    _id: 'f-1', plate: 'AAA-1', model: 'Fiat Panda', category: 'ECO', categoryCode: 'ECO',
    active: true, status: 'available', operationalStatus: 'available', readyToGo: true,
    ...extra,
  });

  test('a pending booking is confirmed and stamped', async () => {
    install({ bookingRow: booking({ status: 'Pending' }), fleetRows: [fleetRow()] });

    const res = await confirmBookingAnalysis({ authToken: await token(), bookingId: BOOKING_ID });

    expect(res).toMatchObject({ success: true });
    expect(bookingRow()).toMatchObject({ status: 'Confirmed' });
    expect(bookingRow().confirmedAt).toBeTruthy();
    expect(bookingRow().statusChangedAt).toBeTruthy();
  });

  test('the message says whether a vehicle was found', async () => {
    install({ bookingRow: booking({ status: 'Pending' }), fleetRows: [fleetRow()] });

    const res = await confirmBookingAnalysis({ authToken: await token(), bookingId: BOOKING_ID });

    expect(res.message).toBe(res.assigned ? 'Booking confirmed & vehicle assigned' : 'Booking confirmed');
  });

  test('an empty fleet still confirms the booking, without an assignment', async () => {
    install({ bookingRow: booking({ status: 'Pending' }), fleetRows: [] });

    const res = await confirmBookingAnalysis({ authToken: await token(), bookingId: BOOKING_ID });

    expect(res).toMatchObject({ success: true, assigned: false, message: 'Booking confirmed' });
    expect(bookingRow().status).toBe('Confirmed');
  });

  test('an existing confirmation time is kept rather than moved', async () => {
    const confirmedAt = new Date('2026-03-01T00:00:00.000Z');
    install({ bookingRow: booking({ status: 'Pending', confirmedAt }), fleetRows: [fleetRow()] });

    await confirmBookingAnalysis({ authToken: await token(), bookingId: BOOKING_ID });

    expect(new Date(bookingRow().confirmedAt).toISOString()).toBe(confirmedAt.toISOString());
  });

  test('no booking id is refused', async () => {
    install();

    expect(await confirmBookingAnalysis({ authToken: await token(), bookingId: '' }))
      .toMatchObject({ success: false, message: 'Missing bookingId' });
  });

  test('a refusal from the assigner is relayed rather than swallowed', async () => {
    install({ bookingRow: booking({ status: 'Canceled' }), fleetRows: [fleetRow()] });

    const res = await confirmBookingAnalysis({ authToken: await token(), bookingId: BOOKING_ID });

    expect(res.success).toBe(false);
    expect(res.message).toEqual(expect.any(String));
    expect(bookingRow().status).toBe('Canceled');
  });

  test('a write that fails is reported rather than thrown', async () => {
    install({ bookingRow: booking({ status: 'Pending' }), fleetRows: [fleetRow()] });
    const authToken = await token();
    const original = wixData.update;
    wixData.update = (collection, ...rest) => (
      collection === 'BookingsNew' && rest[0]?._id === BOOKING_ID && rest[0]?.status === 'Confirmed'
        ? Promise.reject(new Error('write refused'))
        : original.call(wixData, collection, ...rest)
    );
    try {
      expect(await confirmBookingAnalysis({ authToken, bookingId: BOOKING_ID }))
        .toMatchObject({ success: false, message: 'write refused' });
    } finally {
      wixData.update = original;
    }
  });

  test('an operator who may only view rentals is refused outright', async () => {
    install({ bookingRow: booking({ status: 'Pending' }) });
    fake.restore();
    const salt = randomHex(16);
    const rows = seed({ bookingRow: booking({ status: 'Pending' }) });
    rows.StaffRoles.push({
      _id: 'role-viewer', key: 'viewer', label: 'Viewer', active: true,
      rentalsView: true, specialPermissions: '',
    });
    rows.StaffUsers.push({ _id: 'u-2', email: 'viewer@example.com', fullName: 'A Viewer', roleKey: 'viewer', active: true });
    rows.StaffCredentials.push({
      _id: 'c-2', email: 'viewer@example.com', passwordSalt: salt,
      passwordHash: derivePasswordHash(PASSWORD, salt), active: true,
    });
    fake = createFakeWixData(rows).install(wixData);
    const { sessionToken } = await loginStaff({ email: 'viewer@example.com', password: PASSWORD });

    await expect(confirmBookingAnalysis({ authToken: sessionToken, bookingId: BOOKING_ID }))
      .rejects.toThrow();
  });
});

describe('the insights endpoints when their collection is unreadable', () => {
  // The staff collections stay readable in both tests below, or the session
  // check in front of each endpoint would throw before the code under test ran.
  const withBrokenData = async (fn) => {
    install();
    const authToken = await token();
    const original = wixData.query;
    wixData.query = (name) => {
      if (String(name).startsWith('Staff')) return original.call(wixData, name);
      throw new Error('collection missing');
    };
    try { return await fn(authToken); } finally { wixData.query = original; }
  };

  test('a failing customer lookup is reported as a failure', async () => {
    const res = await withBrokenData((authToken) =>
      getCustomerInsights({ authToken, customer: { email: 'a@example.com' } }));

    expect(res).toMatchObject({ success: false, message: 'collection missing', summary: null });
    expect(res.history).toEqual([]);
  });

  test('a failing company lookup reports success and an empty history instead', async () => {
    // The inconsistency worth knowing about. getCompanyInsights guards every one
    // of its own queries individually and degrades each to an empty result, so
    // nothing ever reaches its outer catch: an unreadable Companies collection
    // is reported to the panel as "this company has no history" rather than as
    // "we could not look". Its customer twin, whose booking query is not
    // guarded, says so plainly — as asserted just above.
    //
    // Pinned as it behaves rather than changed; the outer catch on the company
    // side is unreachable through a broken collection, which is why that pair
    // of lines is the file's last uncovered fragment.
    const res = await withBrokenData((authToken) =>
      getCompanyInsights({ authToken, company: { vatNumber: 'EL123' } }));

    expect(res.success).toBe(true);
    expect(res.history).toEqual([]);
    expect(res.summary).toMatchObject({ collected: 0, futureBookings: 0 });
  });
});

describe('the vehicle fields a save mirrors onto both records', () => {
  const save = async (payload) => {
    install({ bookingRow: booking({ assignedVehicle: 'f-1' }) });
    const res = await saveContract({ authToken: await token(), bookingId: BOOKING_ID, payload });
    expect(res.success).toBe(true);
    return res;
  };

  test.each([
    ['assignedVehicleModel', 'Fiat Panda'],
    ['assignedVehicleStationCode', 'SKG'],
    ['assignedVehicleStationLabel', 'Thessaloniki Port'],
    ['assignedCategoryCode', 'ECO'],
  ])('%s is written to the booking and to the rental', async (field, value) => {
    // Both records carry the vehicle, and a screen that reads one while the
    // other says something else is how a contract prints the wrong car.
    await save({ [field]: value });

    expect(bookingRow()[field]).toBe(value);
    expect(rentalRow()[field]).toBe(value);
  });

  test.each([
    ['assignedVehicleMileage', '41200', 41200],
    ['assignedVehicleFuelLevel', '8.5', 8.5],
    ['assignedVehicleExcess', 'not a number', 0],
  ])('%s is stored as a number on both', async (field, sent, stored) => {
    await save({ [field]: sent });

    expect(bookingRow()[field]).toBe(stored);
    expect(rentalRow()[field]).toBe(stored);
  });

  test('a field the payload does not mention is left alone on both', async () => {
    install({ bookingRow: booking({ assignedVehicle: 'f-1', assignedVehicleModel: 'VW Polo' }) });

    await saveContract({ authToken: await token(), bookingId: BOOKING_ID, payload: { customerName: 'A Customer' } });

    expect(bookingRow().assignedVehicleModel).toBe('VW Polo');
  });

  test('an explicitly empty value clears the field rather than being skipped', async () => {
    install({ bookingRow: booking({ assignedVehicle: 'f-1', assignedVehicleModel: 'VW Polo' }) });

    await saveContract({
      authToken: await token(), bookingId: BOOKING_ID, payload: { assignedVehicleModel: '' },
    });

    expect(bookingRow().assignedVehicleModel).toBe('');
  });
});

describe('the photos field', () => {
  const savePhotos = async (photos) => {
    install();
    const res = await saveContract({ authToken: await token(), bookingId: BOOKING_ID, payload: { photos } });
    expect(res.success).toBe(true);
    return rentalRow().photos;
  };

  test('a list of urls is kept, trimmed, with blanks dropped', async () => {
    expect(await savePhotos(['  a.jpg ', '', 'b.jpg', '   '])).toEqual(['a.jpg', 'b.jpg']);
  });

  test('a comma-separated string is split into a list', async () => {
    // Legacy rows stored the field as text; both spellings have to land the
    // same way or the gallery renders one long broken url.
    expect(await savePhotos('a.jpg, b.jpg ,c.jpg')).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });

  test('an empty string becomes an empty list rather than a list with one blank', async () => {
    expect(await savePhotos('')).toEqual([]);
    expect(await savePhotos('   ')).toEqual([]);
  });

  test('a single url with no commas is still a list', async () => {
    expect(await savePhotos('only.jpg')).toEqual(['only.jpg']);
  });

  test('trailing separators do not leave empty entries behind', async () => {
    expect(await savePhotos('a.jpg,,b.jpg,')).toEqual(['a.jpg', 'b.jpg']);
  });

  test('an empty list stays empty', async () => {
    expect(await savePhotos([])).toEqual([]);
  });
});
