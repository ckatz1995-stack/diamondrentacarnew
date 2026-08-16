import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import { moveBookingVehicleOnly, confirmAndAutoAssign } from '../fleetCalendar.jsw';

// The other half of double-booking protection. createBooking guards the category
// at booking time; these guard the individual vehicle at assignment time — a
// dispatcher dragging a booking onto a car in the fleet calendar.

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';

const CAR_A = 'car-a';
const CAR_B = 'car-b';

// The booking under test occupies 12-15 Jan.
const START = '2026-01-12T08:00:00.000Z';
const END = '2026-01-15T08:00:00.000Z';

function booking(id, overrides = {}) {
  // Field names match the F defaults in fleetCalendar; ensureFieldMapping samples a
  // row to detect the real schema, so the seed must use the canonical names.
  return {
    _id: id,
    status: 'Confirmed',
    rentalState: '',
    bookingNumber: `RNT-2026-${id}`,
    customerName: 'A Customer',
    categoryId: 'ECO',
    category: 'ECO',
    pickupDateTime: START,
    dropoffDateTime: END,
    assignedVehicle: null,
    ...overrides,
  };
}

function seed(extra = {}) {
  const passwordSalt = randomHex(16);
  return {
    StaffRoles: [{ _id: 'role-admin', key: 'admin', label: 'Administrator', active: true, sortOrder: 1 }],
    StaffUsers: [{ _id: 'user-1', email: EMAIL, fullName: 'Admin', roleKey: 'admin', active: true }],
    StaffCredentials: [{
      _id: 'cred-1', email: EMAIL, passwordSalt,
      passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true,
    }],
    StaffSessions: [],
    StaffAuditLog: [],
    FleetNew: [
      { _id: CAR_A, active: true, category: 'ECO', plate: 'AAA-1111', model: 'i10' },
      { _id: CAR_B, active: true, category: 'ECO', plate: 'BBB-2222', model: 'Picanto' },
    ],
    BookingsNew: [booking('bk-1')],
    ...extra,
  };
}

let fake;
function install(s = seed()) {
  fake = createFakeWixData(s).install(wixData);
  return fake;
}
async function token() {
  const { sessionToken } = await loginStaff({ email: EMAIL, password: PASSWORD });
  return sessionToken;
}
const stored = (id) => fake.rows('BookingsNew').find((b) => b._id === id);

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('moveBookingVehicleOnly — auth', () => {
  test('rejects a missing or bogus token', async () => {
    install();
    await expect(moveBookingVehicleOnly({ bookingId: 'bk-1', newVehicleId: CAR_A }))
      .rejects.toThrow('AUTH_REQUIRED');
    await expect(moveBookingVehicleOnly({ authToken: 'nope', bookingId: 'bk-1', newVehicleId: CAR_A }))
      .rejects.toThrow('AUTH_REQUIRED');
  });

  test('assigns nothing when unauthenticated', async () => {
    install();
    await moveBookingVehicleOnly({ authToken: 'nope', bookingId: 'bk-1', newVehicleId: CAR_A }).catch(() => {});
    expect(stored('bk-1').assignedVehicle).toBeNull();
  });
});

describe('moveBookingVehicleOnly — the overlap guard', () => {
  test('refuses to put two overlapping bookings on the same vehicle', async () => {
    // The double-booking case: CAR_A is already taken for an overlapping window.
    install(seed({
      BookingsNew: [
        booking('bk-1'),
        booking('bk-2', { assignedVehicle: CAR_A, pickupDateTime: '2026-01-13T08:00:00.000Z', dropoffDateTime: '2026-01-20T08:00:00.000Z' }),
      ],
    }));
    const result = await moveBookingVehicleOnly({ authToken: await token(), bookingId: 'bk-1', newVehicleId: CAR_A });

    expect(result).toMatchObject({ success: false, message: 'Overlap' });
    expect(stored('bk-1').assignedVehicle).toBeNull();
  });

  test('allows a back-to-back booking on the same vehicle', async () => {
    // Ends exactly when the other begins — a handover, not a conflict. Same
    // half-open rule as bookingsOverlap().
    install(seed({
      BookingsNew: [
        booking('bk-1'),
        booking('bk-2', { assignedVehicle: CAR_A, pickupDateTime: END, dropoffDateTime: '2026-01-20T08:00:00.000Z' }),
      ],
    }));
    const result = await moveBookingVehicleOnly({ authToken: await token(), bookingId: 'bk-1', newVehicleId: CAR_A });

    expect(result.success).toBe(true);
    expect(stored('bk-1').assignedVehicle).toBe(CAR_A);
  });

  test('ignores a cancelled booking when checking the vehicle', async () => {
    install(seed({
      BookingsNew: [
        booking('bk-1'),
        booking('bk-2', { assignedVehicle: CAR_A, status: 'Canceled' }),
      ],
    }));
    const result = await moveBookingVehicleOnly({ authToken: await token(), bookingId: 'bk-1', newVehicleId: CAR_A });
    expect(result.success).toBe(true);
  });

  test('does not treat the booking itself as a conflict when reassigning', async () => {
    // Moving a booking onto the vehicle it already occupies must not self-conflict.
    install(seed({ BookingsNew: [booking('bk-1', { assignedVehicle: CAR_A })] }));
    const result = await moveBookingVehicleOnly({ authToken: await token(), bookingId: 'bk-1', newVehicleId: CAR_A });
    expect(result.success).toBe(true);
  });

  test('permits the same window on a different vehicle', async () => {
    install(seed({
      BookingsNew: [booking('bk-1'), booking('bk-2', { assignedVehicle: CAR_A })],
    }));
    const result = await moveBookingVehicleOnly({ authToken: await token(), bookingId: 'bk-1', newVehicleId: CAR_B });
    expect(result.success).toBe(true);
    expect(stored('bk-1').assignedVehicle).toBe(CAR_B);
  });
});

describe('moveBookingVehicleOnly — assignment and unassignment', () => {
  test('records the vehicle plate, model and label on assignment', async () => {
    install();
    await moveBookingVehicleOnly({ authToken: await token(), bookingId: 'bk-1', newVehicleId: CAR_A });

    const row = stored('bk-1');
    expect(row.assignedVehicle).toBe(CAR_A);
    expect(row.assignedVehiclePlate).toBe('AAA-1111');
    expect(row.assignedVehicleModel).toBe('i10');
    expect(row.assignedVehicleLabel).toBe('AAA-1111 - i10');
  });

  test('clears the assignment for the unassigned sentinel', async () => {
    install(seed({ BookingsNew: [booking('bk-1', { assignedVehicle: CAR_A, assignedVehiclePlate: 'AAA-1111' })] }));
    const result = await moveBookingVehicleOnly({ authToken: await token(), bookingId: 'bk-1', newVehicleId: 'unassigned' });

    expect(result.success).toBe(true);
    const row = stored('bk-1');
    expect(row.assignedVehicle).toBeNull();
    expect(row.assignedVehiclePlate).toBe('');
  });

  test('accepts resourceId as an alias for newVehicleId', async () => {
    install();
    const result = await moveBookingVehicleOnly({ authToken: await token(), bookingId: 'bk-1', resourceId: CAR_A });
    expect(result.success).toBe(true);
    expect(stored('bk-1').assignedVehicle).toBe(CAR_A);
  });
});

describe('moveBookingVehicleOnly — refusals', () => {
  test('refuses without a booking id or target', async () => {
    install();
    const t = await token();
    await expect(moveBookingVehicleOnly({ authToken: t, newVehicleId: CAR_A })).resolves.toMatchObject({ message: 'MissingParams' });
    await expect(moveBookingVehicleOnly({ authToken: t, bookingId: 'bk-1' })).resolves.toMatchObject({ message: 'MissingParams' });
  });

  test('refuses an unknown booking', async () => {
    install();
    await expect(moveBookingVehicleOnly({ authToken: await token(), bookingId: 'nope', newVehicleId: CAR_A }))
      .resolves.toMatchObject({ message: 'NotFound' });
  });

  test.each(['Active Rental', 'Pre Check-In'])('refuses to move a booking in %s', async (rentalState) => {
    // A car that has already gone out must not be reassigned underneath the rental.
    install(seed({ BookingsNew: [booking('bk-1', { rentalState })] }));
    const result = await moveBookingVehicleOnly({ authToken: await token(), bookingId: 'bk-1', newVehicleId: CAR_A });
    expect(result).toMatchObject({ success: false, message: 'LockedRentalState' });
    expect(stored('bk-1').assignedVehicle).toBeNull();
  });

  test('refuses to move a maintenance or block entry', async () => {
    install(seed({ BookingsNew: [booking('bk-1', { bookingNumber: 'BLOCK-001' })] }));
    const result = await moveBookingVehicleOnly({ authToken: await token(), bookingId: 'bk-1', newVehicleId: CAR_A });
    expect(result).toMatchObject({ success: false, message: 'NonRevenueLocked' });
  });

  test('refuses a booking with no dates', async () => {
    install(seed({ BookingsNew: [booking('bk-1', { pickupDateTime: null, dropoffDateTime: null })] }));
    const result = await moveBookingVehicleOnly({ authToken: await token(), bookingId: 'bk-1', newVehicleId: CAR_A });
    expect(result).toMatchObject({ success: false, message: 'MissingDates' });
  });
});

describe('confirmAndAutoAssign', () => {
  test('rejects an unauthenticated caller', async () => {
    install();
    await expect(confirmAndAutoAssign({ bookingId: 'bk-1' })).rejects.toThrow('AUTH_REQUIRED');
  });

  test('confirms a pending booking and assigns the first free vehicle', async () => {
    install(seed({ BookingsNew: [booking('bk-1', { status: 'Pending' })] }));
    const result = await confirmAndAutoAssign({ authToken: await token(), bookingId: 'bk-1' });

    expect(result).toMatchObject({ success: true, assigned: true });
    const row = stored('bk-1');
    expect(row.status).toBe('Confirmed');
    expect(row.assignedVehicle).toBe(CAR_A);
  });

  test('skips a vehicle that is already committed for the window', async () => {
    // CAR_A is taken, so it must land on CAR_B rather than double-booking CAR_A.
    install(seed({
      BookingsNew: [booking('bk-1', { status: 'Pending' }), booking('bk-2', { assignedVehicle: CAR_A })],
    }));
    const result = await confirmAndAutoAssign({ authToken: await token(), bookingId: 'bk-1' });

    expect(result.assigned).toBe(true);
    expect(stored('bk-1').assignedVehicle).toBe(CAR_B);
  });

  test('assigns nothing when every vehicle in the category is committed', async () => {
    install(seed({
      BookingsNew: [
        booking('bk-1', { status: 'Pending' }),
        booking('bk-2', { assignedVehicle: CAR_A }),
        booking('bk-3', { assignedVehicle: CAR_B }),
      ],
    }));
    const result = await confirmAndAutoAssign({ authToken: await token(), bookingId: 'bk-1' });

    expect(result).toMatchObject({ success: true, assigned: false });
    expect(stored('bk-1').assignedVehicle).toBeNull();
  });

  test('leaves an already-assigned booking alone', async () => {
    install(seed({ BookingsNew: [booking('bk-1', { assignedVehicle: CAR_B })] }));
    const result = await confirmAndAutoAssign({ authToken: await token(), bookingId: 'bk-1' });

    expect(result).toMatchObject({ success: true, alreadyAssigned: true });
    expect(stored('bk-1').assignedVehicle).toBe(CAR_B);
  });

  test('refuses to confirm a cancelled booking', async () => {
    install(seed({ BookingsNew: [booking('bk-1', { status: 'Canceled' })] }));
    const result = await confirmAndAutoAssign({ authToken: await token(), bookingId: 'bk-1' });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/canceled/i);
    expect(stored('bk-1').status).toBe('Canceled');
  });

  test('refuses to confirm a booking in an unexpected status', async () => {
    install(seed({ BookingsNew: [booking('bk-1', { status: 'Completed' })] }));
    const result = await confirmAndAutoAssign({ authToken: await token(), bookingId: 'bk-1' });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Completed/);
  });

  test('tolerates legacy lowercase and padded status values', async () => {
    // The normalisation exists so 'pending' and 'Confirmed ' still flow through.
    install(seed({ BookingsNew: [booking('bk-1', { status: '  pending ' })] }));
    const result = await confirmAndAutoAssign({ authToken: await token(), bookingId: 'bk-1' });
    expect(result.success).toBe(true);
    expect(stored('bk-1').status).toBe('Confirmed');
  });

  test('refuses without a booking id, and for an unknown booking', async () => {
    install();
    const t = await token();
    await expect(confirmAndAutoAssign({ authToken: t })).resolves.toMatchObject({ message: 'MissingParams' });
    await expect(confirmAndAutoAssign({ authToken: t, bookingId: 'nope' })).resolves.toMatchObject({ message: 'NotFound' });
  });
});
