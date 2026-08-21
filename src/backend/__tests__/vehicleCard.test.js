import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import { getVehicleCardData, saveVehicleCardData } from '../vehicleCard.jsw';

// The per-vehicle card a branch opens to see one car's whole history: its fleet
// record, its category, every rental it has been out on, and the money those
// rentals brought in.
//
// It is unusual in this codebase for looking a record up several ways — by
// internal id or business key — and for gathering rentals through three
// different foreign keys before deduplicating them.
//
// These run in the fake's strict-collections mode, where an unseeded collection
// throws the way real wix-data does. That mode was added to prove the old
// legacy-collection fallbacks actually ran; the fallbacks are gone now, but the
// strictness is worth keeping: it catches a query aimed at a collection this
// module does not own.

const STAFF = 'staff@example.com';
const READER = 'reader@example.com';
const PASSWORD = 'correct-horse-battery';
const FLEET_ID = 'fleet-1';

function credential(email) {
  const passwordSalt = randomHex(16);
  return {
    _id: `cred-${email}`, email, passwordSalt,
    passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true,
  };
}

function staffCollections() {
  return {
    StaffRoles: [
      { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true },
      // Can look at the fleet but not change it.
      { _id: 'role-viewer', key: 'viewer', label: 'Viewer', active: true, fleetView: true, specialPermissions: '' },
    ],
    StaffUsers: [
      { _id: 'user-1', email: STAFF, fullName: 'Staff', roleKey: 'admin', active: true },
      { _id: 'user-2', email: READER, fullName: 'Reader', roleKey: 'viewer', active: true },
    ],
    StaffCredentials: [credential(STAFF), credential(READER)],
    StaffSessions: [],
    StaffAuditLog: [],
  };
}

function seed(extra = {}) {
  return {
    ...staffCollections(),
    FleetNew: [{
      _id: FLEET_ID,
      fleetVehicleId: 'FV-001',
      plate: 'AAA-1111',
      model: 'Aygo',
      categoryId: 'cat-eco',
      active: true,
      operationalStatus: 'Ready',
      readyToGo: true,
      hardHold: false,
      mileage: 42000,
    }],
    VehiclesNew: [{
      _id: 'v-eco', categoryRecordId: 'cat-eco', categoryCode: 'ECO',
      categoryLabel: 'Economy', basePricePerDay: 45, active: true, seats: 5,
    }],
    RentalsNew: [],
    BookingsNew: [],
    ...extra,
  };
}

let fake;
function install(s = seed()) {
  // Strict: an unseeded collection throws, the way wix-data does.
  fake = createFakeWixData(s, { strictCollections: true }).install(wixData);
  return fake;
}
async function token(email = STAFF) {
  const { sessionToken } = await loginStaff({ email, password: PASSWORD });
  return sessionToken;
}
const card = async (over = {}) => getVehicleCardData({ sessionToken: await token(), fleetVehicleId: FLEET_ID, ...over });
const fleetRow = () => fake.rows('FleetNew').find((f) => f._id === FLEET_ID);
// Authenticating touches the session row, so every assertion about what a call
// wrote has to name the collection it cares about.
const fleetWrites = () => fake.calls.update.filter((c) => c.collection === 'FleetNew');

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('auth gating', () => {
  const CALLS = [
    ['getVehicleCardData', getVehicleCardData],
    ['saveVehicleCardData', saveVehicleCardData],
  ];

  test.each(CALLS)('%s refuses a missing token', async (_name, fn) => {
    install();
    await expect(fn({ fleetVehicleId: FLEET_ID })).rejects.toThrow('AUTH_REQUIRED');
  });

  test.each(CALLS)('%s refuses a bogus token', async (_name, fn) => {
    install();
    await expect(fn({ sessionToken: 'made-up', fleetVehicleId: FLEET_ID })).rejects.toThrow('AUTH_REQUIRED');
  });

  test('a viewer may read the card', async () => {
    install();
    const result = await getVehicleCardData({ sessionToken: await token(READER), fleetVehicleId: FLEET_ID });
    expect(result.success).toBe(true);
  });

  test('a viewer may not save it', async () => {
    // Reading and writing are separate permissions on the same screen.
    install();
    await expect(saveVehicleCardData({
      sessionToken: await token(READER), fleetVehicleId: FLEET_ID, patch: { plate: 'ZZZ-9999' },
    })).rejects.toThrow('ACCESS_DENIED');
    expect(fleetRow().plate).toBe('AAA-1111');
  });

  test('nothing is written when the caller is unauthenticated', async () => {
    install();
    await saveVehicleCardData({ sessionToken: 'made-up', fleetVehicleId: FLEET_ID, patch: { plate: 'ZZZ' } }).catch(() => {});
    expect(fleetWrites()).toHaveLength(0);
  });
});

describe('finding the vehicle', () => {
  test('by its internal id', async () => {
    install();
    const result = await card();
    expect(result.fleet.plate).toBe('AAA-1111');
  });

  test('by its business key', async () => {
    // The card is opened from screens that hold one identifier or the other.
    install();
    const result = await card({ fleetVehicleId: 'FV-001' });
    expect(result.fleet.plate).toBe('AAA-1111');
  });

  test('a legacy Fleet collection is not consulted', async () => {
    // The candidate-name fallbacks are gone. A record living only under the old
    // `Fleet` name is not found — which is the honest outcome, since it could
    // never have been saved either: the write always targeted FleetNew.
    const s = seed();
    delete s.FleetNew;
    s.Fleet = [{ _id: FLEET_ID, plate: 'LEG-0001', model: 'Panda', categoryId: 'cat-eco' }];
    install(s);
    await expect(card()).rejects.toThrow('FLEET_VEHICLE_NOT_FOUND');
  });

  test.each([
    ['a missing id', '', 'MISSING_FLEET_VEHICLE_ID'],
    ['a blank id', '   ', 'MISSING_FLEET_VEHICLE_ID'],
    ['an unknown id', 'nope', 'FLEET_VEHICLE_NOT_FOUND'],
  ])('rejects %s', async (_label, fleetVehicleId, message) => {
    install();
    await expect(card({ fleetVehicleId })).rejects.toThrow(message);
  });
});

describe('category resolution', () => {
  test('the category is matched by its record id', async () => {
    install();
    const result = await card();
    expect(result.category.categoryCode).toBe('ECO');
    expect(result.category.basePricePerDay).toBe(45);
  });

  test('the category is matched by code when the vehicle has no category id', async () => {
    const s = seed();
    s.FleetNew[0].categoryId = '';
    s.FleetNew[0].categoryCode = 'ECO';
    install(s);
    expect((await card()).category.categoryLabel).toBe('Economy');
  });

  test('the category fills in labels the fleet record lacks', async () => {
    install();
    const result = await card();
    expect(result.fleet.categoryCode).toBe('ECO');
    expect(result.fleet.categoryLabel).toBe('Economy');
  });

  test('a vehicle whose category is missing still returns a card', async () => {
    // The card is mostly about the vehicle; an unmatched category should not
    // withhold its history.
    const s = seed();
    s.VehiclesNew = [];
    install(s);
    const result = await card();
    expect(result.success).toBe(true);
    expect(result.category.categoryCode).toBe('');
  });

  test('a vehicle label is composed from plate and model when not stored', async () => {
    install();
    expect((await card()).fleet.vehicleLabel).toBe('AAA-1111 - Aygo');
  });
});

describe('rental history', () => {
  function withRentals(rentals, bookings = []) {
    const s = seed();
    s.RentalsNew = rentals;
    s.BookingsNew = bookings;
    return s;
  }

  test('rentals are found by the internal vehicle id', async () => {
    install(withRentals([{ _id: 'r-1', assignedVehicleId: FLEET_ID, rentalState: 'Closed Rental' }]));
    expect((await card()).rentals).toHaveLength(1);
  });

  test('rentals are found by the business vehicle id', async () => {
    install(withRentals([{ _id: 'r-1', assignedVehicleId: 'FV-001', rentalState: 'Closed Rental' }]));
    expect((await card()).rentals).toHaveLength(1);
  });

  test('rentals are found by fleetVehicleId', async () => {
    install(withRentals([{ _id: 'r-1', fleetVehicleId: 'FV-001', rentalState: 'Closed Rental' }]));
    expect((await card()).rentals).toHaveLength(1);
  });

  test('a rental reachable by more than one key is listed once', async () => {
    // Three lookups feed one list. Without dedup the same rental would be
    // counted twice in every total on the summary.
    install(withRentals([{
      _id: 'r-1', rentalId: 'RENT-1', assignedVehicleId: FLEET_ID, fleetVehicleId: 'FV-001',
      rentalState: 'Closed Rental',
    }]));
    const result = await card();
    expect(result.rentals).toHaveLength(1);
    expect(result.summary.totalRentals).toBe(1);
  });

  test('a rental is joined to its booking for the customer details', async () => {
    install(withRentals(
      [{ _id: 'r-1', assignedVehicleId: FLEET_ID, bookingId: 'bk-1', rentalState: 'Closed Rental' }],
      [{ _id: 'bk-1', bookingNumber: 'RNT-2026-0001', customerName: 'A Customer', pickupDateTime: '2026-03-10T09:00:00.000Z' }],
    ));
    const [row] = (await card()).rentals;
    expect(row.bookingNumber).toBe('RNT-2026-0001');
    expect(row.customerName).toBe('A Customer');
  });

  test('a booking is joined by its business id as well as its internal one', async () => {
    install(withRentals(
      [{ _id: 'r-1', assignedVehicleId: FLEET_ID, bookingId: 'BK-BUS-1' }],
      [{ _id: 'bk-1', bookingId: 'BK-BUS-1', bookingNumber: 'RNT-2026-0002', customerName: 'B Customer' }],
    ));
    expect((await card()).rentals[0].customerName).toBe('B Customer');
  });

  test('a rental whose booking is gone still appears', async () => {
    // The vehicle was out; losing the booking record must not erase that.
    install(withRentals([{ _id: 'r-1', assignedVehicleId: FLEET_ID, bookingId: 'missing' }]));
    const [row] = (await card()).rentals;
    expect(row.rentalId).toBe('r-1');
    expect(row.customerName).toBe('');
  });

  test('history is ordered newest pickup first', async () => {
    install(withRentals(
      [
        { _id: 'r-old', assignedVehicleId: FLEET_ID, bookingId: 'bk-old' },
        { _id: 'r-new', assignedVehicleId: FLEET_ID, bookingId: 'bk-new' },
        { _id: 'r-mid', assignedVehicleId: FLEET_ID, bookingId: 'bk-mid' },
      ],
      [
        { _id: 'bk-old', pickupDateTime: '2025-01-05T09:00:00.000Z' },
        { _id: 'bk-new', pickupDateTime: '2026-06-01T09:00:00.000Z' },
        { _id: 'bk-mid', pickupDateTime: '2025-09-15T09:00:00.000Z' },
      ],
    ));
    expect((await card()).rentals.map((r) => r.rentalId)).toEqual(['r-new', 'r-mid', 'r-old']);
  });

  test('another vehicle\'s rentals are not included', async () => {
    install(withRentals([
      { _id: 'r-mine', assignedVehicleId: FLEET_ID },
      { _id: 'r-theirs', assignedVehicleId: 'fleet-other' },
    ]));
    expect((await card()).rentals.map((r) => r.rentalId)).toEqual(['r-mine']);
  });
});

describe('money on the card', () => {
  function withRental(rental, booking = {}) {
    const s = seed();
    s.RentalsNew = [{ _id: 'r-1', assignedVehicleId: FLEET_ID, bookingId: 'bk-1', ...rental }];
    s.BookingsNew = [{ _id: 'bk-1', ...booking }];
    return s;
  }
  const firstRow = async () => (await card()).rentals[0];

  test('the rental financial snapshot is preferred', async () => {
    install(withRental(
      { financialSnapshot: { totals: { gross: 250 } } },
      { financialSnapshot: { totals: { gross: 999 } } },
    ));
    expect((await firstRow()).totalGross).toBe(250);
  });

  test('the booking snapshot is used when the rental has none', async () => {
    install(withRental({}, { financialSnapshot: { totals: { gross: 180 } } }));
    expect((await firstRow()).totalGross).toBe(180);
  });

  test('charges JSON is the last resort', async () => {
    install(withRental({ chargesJson: JSON.stringify({ gross: 133.5 }) }));
    expect((await firstRow()).totalGross).toBe(133.5);
  });

  test('a charges total is summed from its parts when no gross is given', async () => {
    install(withRental({ chargesJson: JSON.stringify({ rental: 100, insurance: 30, options: 12, discount: 20 }) }));
    expect((await firstRow()).totalGross).toBe(122);
  });

  test('a charges discount is subtracted, not added', async () => {
    install(withRental({ chargesJson: JSON.stringify({ rental: 100, discount: 25 }) }));
    expect((await firstRow()).totalGross).toBe(75);
  });

  test('charges given as an object rather than a string are read too', async () => {
    install(withRental({ chargesJson: { rental: 40, insurance: 10 } }));
    expect((await firstRow()).totalGross).toBe(50);
  });

  test.each([
    ['malformed JSON', '{not json'],
    ['an empty string', ''],
    ['null', null],
    ['a bare number', '42'],
  ])('%s in chargesJson yields zero rather than throwing', async (_label, chargesJson) => {
    install(withRental({ chargesJson }));
    const row = await firstRow();
    expect(Number.isFinite(row.totalGross)).toBe(true);
    expect(row.totalGross).toBe(0);
  });

  test('an explicit zero gross is kept, not replaced by a recomputation', async () => {
    // A fully discounted rental is a real zero.
    install(withRental({ chargesJson: JSON.stringify({ gross: 0, rental: 100 }) }));
    expect((await firstRow()).totalGross).toBe(0);
  });

  test('amounts are rounded to cents', async () => {
    install(withRental({ chargesJson: JSON.stringify({ rental: 33.333, insurance: 0.009 }) }));
    expect((await firstRow()).totalGross).toBe(33.34);
  });

  test('lifetime revenue and outstanding exposure sum the history', async () => {
    const s = seed();
    s.RentalsNew = [
      { _id: 'r-1', assignedVehicleId: FLEET_ID, financialSnapshot: { totals: { gross: 100 }, settlement: { balance: 20 } } },
      { _id: 'r-2', assignedVehicleId: FLEET_ID, financialSnapshot: { totals: { gross: 250.5 }, settlement: { balance: 0 } } },
    ];
    install(s);
    const { summary } = await card();
    expect(summary.lifetimeRevenue).toBe(350.5);
    expect(summary.outstandingExposure).toBe(20);
  });
});

describe('the summary', () => {
  function withStates(states) {
    const s = seed();
    s.RentalsNew = states.map((rentalState, i) => ({
      _id: `r-${i}`, assignedVehicleId: FLEET_ID, rentalState,
    }));
    return s;
  }

  test.each([
    ['Open Rental'], ['Check-Out'], ['Out'], ['Active Rental'], ['Pre Check-In'],
  ])('%s counts as an active rental', async (state) => {
    install(withStates([state]));
    expect((await card()).summary.activeRentals).toBe(1);
  });

  test.each([['Closed Rental'], ['Booking'], ['Canceled'], ['']])(
    '%s does not count as an active rental', async (state) => {
      install(withStates([state]));
      expect((await card()).summary.activeRentals).toBe(0);
    },
  );

  test('bookings that never became rentals are counted separately', async () => {
    install(withStates(['Booking', 'Booking', 'Closed Rental']));
    const { summary } = await card();
    expect(summary.bookingOnly).toBe(2);
    expect(summary.totalRentals).toBe(3);
  });

  test('the last checkout and check-in are the most recent ones', async () => {
    const s = seed();
    s.RentalsNew = [
      { _id: 'r-old', assignedVehicleId: FLEET_ID, bookingId: 'bk-old', checkoutAt: '2025-01-05T09:00:00.000Z', checkinAt: '2025-01-09T09:00:00.000Z' },
      { _id: 'r-new', assignedVehicleId: FLEET_ID, bookingId: 'bk-new', checkoutAt: '2026-06-01T09:00:00.000Z', checkinAt: '2026-06-04T09:00:00.000Z' },
    ];
    s.BookingsNew = [
      { _id: 'bk-old', pickupDateTime: '2025-01-05T09:00:00.000Z' },
      { _id: 'bk-new', pickupDateTime: '2026-06-01T09:00:00.000Z' },
    ];
    install(s);
    const { summary } = await card();
    expect(summary.lastCheckoutAt).toBe('2026-06-01T09:00:00.000Z');
    expect(summary.lastCheckinAt).toBe('2026-06-04T09:00:00.000Z');
  });

  test('a vehicle that has never moved reports empty timestamps, not an error', async () => {
    install();
    const { summary } = await card();
    expect(summary.totalRentals).toBe(0);
    expect(summary.lastCheckoutAt).toBe('');
    expect(summary.lifetimeRevenue).toBe(0);
  });

  test.each([
    ['operationalStatus', 'Service', true],
    ['operationalStatus', 'Blocked', true],
    ['operationalStatus', 'Inactive', true],
    ['operationalStatus', 'Ready', false],
    ['status', 'blocked', true],
  ])('%s of "%s" gives serviceBlocked = %s', async (field, value, expected) => {
    const s = seed();
    s.FleetNew[0].operationalStatus = '';
    s.FleetNew[0][field] = value;
    install(s);
    expect((await card()).summary.operationalFlags.serviceBlocked).toBe(expected);
  });

  test('the ready and hold flags come straight off the fleet record', async () => {
    install();
    const { operationalFlags } = (await card()).summary;
    expect(operationalFlags.readyToGo).toBe(true);
    expect(operationalFlags.hardHold).toBe(false);
  });
});

describe('saving the card', () => {
  const save = async (patch, over = {}) => saveVehicleCardData({
    sessionToken: await token(), fleetVehicleId: FLEET_ID, patch, ...over,
  });

  test('a patched field is written', async () => {
    install();
    const result = await save({ plate: 'BBB-2222', notes: 'Scratched bumper' });
    expect(result.fleet.plate).toBe('BBB-2222');
    expect(fleetRow().plate).toBe('BBB-2222');
    expect(fleetRow().notes).toBe('Scratched bumper');
  });

  test('fields absent from the patch keep their current values', async () => {
    install();
    await save({ plate: 'BBB-2222' });
    expect(fleetRow().model).toBe('Aygo');
    expect(fleetRow().mileage).toBe(42000);
  });

  test('a field not on the allowed list is ignored', async () => {
    // `next` is built from the current record plus named fields, so a caller
    // cannot write arbitrary columns through this endpoint.
    install();
    await save({ plate: 'BBB-2222', totalPrice: 999, isAdmin: true });
    expect(fleetRow().totalPrice).toBeUndefined();
    expect(fleetRow().isAdmin).toBeUndefined();
  });

  test('a patch cannot retarget the write to another record', async () => {
    const s = seed();
    s.FleetNew.push({ _id: 'fleet-2', plate: 'CCC-3333', model: 'Polo' });
    install(s);
    await save({ _id: 'fleet-2', plate: 'HACKED' });
    expect(fake.rows('FleetNew').find((f) => f._id === 'fleet-2').plate).toBe('CCC-3333');
    expect(fleetRow().plate).toBe('HACKED');
  });

  test.each([
    ['active', 'active'],
    ['readyToGo', 'readyToGo'],
    ['hardHold', 'hardHold'],
  ])('an explicit false for %s is stored, not treated as absent', async (_label, field) => {
    // `== null` rather than a falsy check is what makes this work; turning a
    // flag off is the common case on this screen.
    const s = seed();
    s.FleetNew[0][field] = true;
    install(s);
    await save({ [field]: false });
    expect(fleetRow()[field]).toBe(false);
  });

  test('a mileage of zero is stored rather than read as "no change"', async () => {
    install();
    await save({ mileage: 0 });
    expect(fleetRow().mileage).toBe(0);
  });

  test.each([['an empty string', ''], ['null', null], ['undefined', undefined]])(
    'a mileage of %s leaves the stored reading alone', async (_label, mileage) => {
      install();
      await save({ mileage });
      expect(fleetRow().mileage).toBe(42000);
    },
  );

  test('an empty string clears a text field', async () => {
    // Distinct from the numeric fields above: clearing a note is meaningful.
    install();
    await save({ notes: 'something' });
    await save({ notes: '' });
    expect(fleetRow().notes).toBe('');
  });

  test('the update is stamped with a fresh timestamp', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
      install();
      await save({ plate: 'BBB-2222' });
      expect(fleetRow().legacyUpdatedAt).toBe('2026-03-10T12:00:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  test('the write passes suppressAuth as the options argument', async () => {
    // wix-data takes options third. Folding it into the item silently drops the
    // elevation and writes a junk column — a mistake this repo has made before.
    install();
    await save({ plate: 'BBB-2222' });
    const write = fleetWrites().at(-1);
    expect(write.collection).toBe('FleetNew');
    expect(write.options).toEqual({ suppressAuth: true });
    expect(write.item.suppressAuth).toBeUndefined();
  });

  test.each([
    ['a missing id', '', 'MISSING_FLEET_VEHICLE_ID'],
    ['an unknown id', 'nope', 'FLEET_VEHICLE_NOT_FOUND'],
  ])('rejects %s before writing anything', async (_label, fleetVehicleId, message) => {
    install();
    await expect(save({ plate: 'X' }, { fleetVehicleId })).rejects.toThrow(message);
    // Filtered by collection: authenticating touches the session row, so an
    // unfiltered assertion on `calls.update` would pass for the wrong reason.
    expect(fleetWrites()).toHaveLength(0);
  });

  test('the saved card comes back normalised', async () => {
    install();
    const result = await save({ mileage: '51000', readyToGo: 'true' });
    expect(result.fleet.mileage).toBe(51000);
    expect(result.fleet.readyToGo).toBe(true);
  });
});

describe('when the rental history cannot be read', () => {
  test('the card still opens, with an empty history rather than an error', async () => {
    // The vehicle's own record is what the operator came for; a rentals
    // collection that will not answer should cost them the history panel, not
    // the whole screen.
    install();
    const sessionToken = await token();
    const original = wixData.query;
    wixData.query = (name) => {
      if (name === 'RentalsNew') throw new Error('collection missing');
      return original.call(wixData, name);
    };
    let res;
    try {
      res = await getVehicleCardData({ sessionToken, fleetVehicleId: FLEET_ID });
    } finally {
      wixData.query = original;
    }

    expect(res.success).toBe(true);
    expect(res.fleet).toMatchObject({ plate: 'AAA-1111' });
    expect(res.rentals).toEqual([]);
    expect(res.summary).toMatchObject({ totalRentals: 0 });
  });

  test('the operational flags still come through', async () => {
    install();
    const sessionToken = await token();
    const original = wixData.query;
    wixData.query = (name) => {
      if (name === 'RentalsNew') throw new Error('collection missing');
      return original.call(wixData, name);
    };
    let res;
    try {
      res = await getVehicleCardData({ sessionToken, fleetVehicleId: FLEET_ID });
    } finally {
      wixData.query = original;
    }

    expect(res.summary.operationalFlags).toMatchObject({ readyToGo: true, hardHold: false });
  });
});
