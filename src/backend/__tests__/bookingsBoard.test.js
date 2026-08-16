import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import { confirmAndAutoAssign } from 'backend/fleetCalendar';
import { getBookingsBoardData, setBookingBoardStatus } from '../bookingsBoard.jsw';

// The bookings board: the list a branch works down, and the one place a booking's
// status is changed by hand.
//
// Two things need pinning. The row flags — overdue, startsToday, unassigned —
// are computed against the wall clock, so they are only meaningful if the clock
// is controlled; every test that touches them fixes the time, otherwise the
// assertion drifts with the day the suite happens to run.
//
// setBookingBoardStatus is the write. Confirming a booking is not a field
// update: it runs auto-assignment first and refuses to record the status if that
// fails. Cancelling needs a permission that editing does not.

jest.mock('backend/fleetCalendar', () => ({
  confirmAndAutoAssign: jest.fn(async () => ({ success: true, assigned: true })),
}));

const ADMIN = 'admin@example.com';
const EDITOR = 'editor@example.com';
const PASSWORD = 'correct-horse-battery';
const NOW = '2026-03-10T12:00:00.000Z';

function credential(email) {
  const passwordSalt = randomHex(16);
  return {
    _id: `cred-${email}`, email, passwordSalt,
    passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true,
  };
}

function booking(over = {}) {
  return {
    _id: 'bk-1',
    bookingNumber: 'RNT-2026-0001',
    status: 'Pending',
    customerName: 'A Customer',
    pickupDateTime: '2026-03-10T10:00:00.000Z',
    dropoffDateTime: '2026-03-14T10:00:00.000Z',
    totalPrice: 208,
    ...over,
  };
}

function seed(extra = {}) {
  return {
    StaffRoles: [
      { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true },
      // May edit bookings but has not been given the right to cancel one.
      {
        _id: 'role-editor', key: 'editor', label: 'Editor', active: true,
        bookingsView: true, bookingsEdit: true, specialPermissions: '',
      },
    ],
    StaffUsers: [
      { _id: 'user-admin', email: ADMIN, fullName: 'Admin', roleKey: 'admin', active: true },
      { _id: 'user-editor', email: EDITOR, fullName: 'Editor', roleKey: 'editor', active: true },
    ],
    StaffCredentials: [credential(ADMIN), credential(EDITOR)],
    StaffSessions: [],
    StaffAuditLog: [],
    BookingsNew: [booking()],
    FleetNew: [],
    ...extra,
  };
}

let fake;
function install(s = seed()) {
  fake = createFakeWixData(s).install(wixData);
  return fake;
}
async function token(email = ADMIN) {
  const { sessionToken } = await loginStaff({ email, password: PASSWORD });
  return sessionToken;
}
async function board(over = {}) {
  const result = await getBookingsBoardData({ authToken: await token(), ...over });
  // The handler catches everything and returns success:false with an empty list,
  // so a crash would otherwise read as "no bookings in range".
  expect(result.success).toBe(true);
  return result;
}
const row = (result, id = 'bk-1') => result.items.find((r) => r._id === id);
const bookingRow = (id = 'bk-1') => fake.rows('BookingsNew').find((b) => b._id === id);
const bookingWrites = () => fake.calls.update.filter((c) => c.collection === 'BookingsNew');

// The board's flags are relative to "now". Freeze it for the whole suite so the
// same assertions hold on any day.
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(NOW));
  confirmAndAutoAssign.mockClear();
  confirmAndAutoAssign.mockResolvedValue({ success: true, assigned: true });
});

afterEach(() => {
  jest.useRealTimers();
  if (fake) fake.restore();
  fake = null;
});

describe('auth gating', () => {
  const CALLS = [
    ['getBookingsBoardData', getBookingsBoardData, {}],
    ['setBookingBoardStatus', setBookingBoardStatus, { bookingId: 'bk-1', newStatus: 'Hold' }],
  ];

  test.each(CALLS)('%s refuses a missing token', async (_name, fn, args) => {
    install();
    await expect(fn({ ...args })).rejects.toThrow('AUTH_REQUIRED');
  });

  test.each(CALLS)('%s refuses a bogus token', async (_name, fn, args) => {
    install();
    await expect(fn({ authToken: 'made-up', ...args })).rejects.toThrow('AUTH_REQUIRED');
  });

  test('viewing the board and changing a status are separate permissions', async () => {
    // Without this, downgrading the write gate to View passes every other test
    // here — "can open the board" would silently mean "can change statuses".
    install(seed({
      StaffRoles: [{
        _id: 'role-watcher', key: 'watcher', label: 'Watcher', active: true,
        bookingsView: true, specialPermissions: '', // view only, no edit
      }],
      StaffUsers: [{ _id: 'user-watcher', email: EDITOR, fullName: 'Watcher', roleKey: 'watcher', active: true }],
      StaffCredentials: [credential(EDITOR)],
    }));
    const watcher = await token(EDITOR);

    await expect(getBookingsBoardData({ authToken: watcher })).resolves.toMatchObject({ success: true });
    await expect(setBookingBoardStatus({ authToken: watcher, bookingId: 'bk-1', newStatus: 'Hold' }))
      .rejects.toThrow('ACCESS_DENIED');
    expect(bookingRow().status).toBe('Pending');
  });

  test('an unauthenticated call changes nothing', async () => {
    install();
    for (const [, fn, args] of CALLS) {
      await fn({ authToken: 'made-up', ...args }).catch(() => {});
    }
    expect(bookingWrites()).toHaveLength(0);
    expect(bookingRow().status).toBe('Pending');
  });
});

describe('the date range', () => {
  test('defaults to the last thirty days through the end of today', async () => {
    install();
    const { filters } = await board();
    expect(filters.startDate).toBe('2026-02-08T00:00:00.000Z');
    expect(filters.endDate).toBe('2026-03-11T00:00:00.000Z');
  });

  test('the end date is inclusive of its own day', async () => {
    // A booking picking up at any hour on the end date belongs to the range, so
    // the exclusive bound has to be the following midnight.
    install();
    const { filters } = await board({ startDate: '2026-03-01', endDate: '2026-03-10' });
    expect(filters.endDate).toBe('2026-03-11T00:00:00.000Z');
  });

  test('the start date is taken from midnight, not from the hour given', async () => {
    install();
    const { filters } = await board({ startDate: '2026-03-01T18:45:00.000Z', endDate: '2026-03-10' });
    expect(filters.startDate).toBe('2026-03-01T00:00:00.000Z');
  });

  test('an inverted range falls back to a month rather than returning nothing', async () => {
    install();
    const { filters } = await board({ startDate: '2026-03-10', endDate: '2026-03-01' });
    expect(filters.startDate).toBe('2026-03-10T00:00:00.000Z');
    expect(filters.endDate).toBe('2026-04-10T00:00:00.000Z');
  });

  test('unparseable dates fall back to the defaults', async () => {
    install();
    const { filters } = await board({ startDate: 'nonsense', endDate: 'nonsense' });
    expect(filters.startDate).toBe('2026-02-08T00:00:00.000Z');
    expect(filters.endDate).toBe('2026-03-11T00:00:00.000Z');
  });

  test('only bookings picking up inside the range are listed', async () => {
    install(seed({
      BookingsNew: [
        booking({ _id: 'bk-before', pickupDateTime: '2026-02-28T10:00:00.000Z' }),
        booking({ _id: 'bk-inside', pickupDateTime: '2026-03-05T10:00:00.000Z' }),
        booking({ _id: 'bk-after', pickupDateTime: '2026-03-20T10:00:00.000Z' }),
      ],
    }));
    const result = await board({ startDate: '2026-03-01', endDate: '2026-03-10' });
    expect(result.items.map((r) => r._id)).toEqual(['bk-inside']);
  });

  test('a booking picking up at the last moment of the end day is included', async () => {
    install(seed({
      BookingsNew: [booking({ _id: 'bk-edge', pickupDateTime: '2026-03-10T23:59:59.999Z' })],
    }));
    const result = await board({ startDate: '2026-03-01', endDate: '2026-03-10' });
    expect(result.items.map((r) => r._id)).toEqual(['bk-edge']);
  });
});

describe('row flags', () => {
  test('a booking overdue for return is flagged', async () => {
    install(seed({
      BookingsNew: [booking({ dropoffDateTime: '2026-03-08T10:00:00.000Z' })],
    }));
    expect(row(await board()).overdue).toBe(true);
  });

  test('a cancelled booking is never overdue however late', async () => {
    // Its dropoff is still in the past; only the status differs.
    install(seed({
      BookingsNew: [booking({ status: 'Canceled', dropoffDateTime: '2026-03-08T10:00:00.000Z' })],
    }));
    expect(row(await board()).overdue).toBe(false);
  });

  test('a booking still out on hire is not overdue', async () => {
    install();
    expect(row(await board()).overdue).toBe(false);
  });

  test('a booking picking up today is flagged', async () => {
    install();
    expect(row(await board()).startsToday).toBe(true);
  });

  test.each([
    ['yesterday', '2026-03-09T10:00:00.000Z'],
    ['tomorrow', '2026-03-11T10:00:00.000Z'],
  ])('a booking picking up %s is not flagged as starting today', async (_label, pickupDateTime) => {
    install(seed({ BookingsNew: [booking({ pickupDateTime })] }));
    expect(row(await board({ startDate: '2026-03-01', endDate: '2026-03-31' })).startsToday).toBe(false);
  });

  test('a booking with no vehicle is flagged unassigned', async () => {
    install();
    expect(row(await board()).unassigned).toBe(true);
  });

  test.each([
    ['a vehicle id', { assignedVehicle: 'car-1' }],
    ['only a plate', { assignedVehiclePlate: 'AAA-1111' }],
    ['only a label', { assignedVehicleLabel: 'AAA-1111 - Aygo' }],
  ])('a booking carrying %s is not flagged unassigned', async (_label, over) => {
    install(seed({ BookingsNew: [booking(over)] }));
    expect(row(await board()).unassigned).toBe(false);
  });
});

describe('vehicle details on a row', () => {
  const FLEET = [{ _id: 'car-1', plate: 'AAA-1111', model: 'Aygo', category: 'ECO - Economy' }];

  test('plate, model and label are resolved from the fleet record', async () => {
    install(seed({ BookingsNew: [booking({ assignedVehicle: 'car-1' })], FleetNew: FLEET }));
    const r = row(await board());
    expect(r.assignedVehiclePlate).toBe('AAA-1111');
    expect(r.assignedVehicleModel).toBe('Aygo');
    expect(r.assignedVehicleLabel).toBe('AAA-1111 - Aygo');
  });

  test('the category code is taken off the assigned vehicle', async () => {
    install(seed({ BookingsNew: [booking({ assignedVehicle: 'car-1' })], FleetNew: FLEET }));
    expect(row(await board()).assignedCategoryCode).toBe('ECO');
  });

  test('a value already on the booking wins over the fleet record', async () => {
    install(seed({
      BookingsNew: [booking({ assignedVehicle: 'car-1', assignedVehiclePlate: 'BOOKED-0000' })],
      FleetNew: FLEET,
    }));
    expect(row(await board()).assignedVehiclePlate).toBe('BOOKED-0000');
  });

  test('a vehicle id with no matching fleet record leaves the row blank rather than failing', async () => {
    install(seed({ BookingsNew: [booking({ assignedVehicle: 'gone' })], FleetNew: [] }));
    const r = row(await board());
    expect(r.assignedVehiclePlate).toBe('');
    expect(r.unassigned).toBe(false); // it does have an id, it just cannot be resolved
  });

  test.each([
    ['assignedCategoryCode', { assignedCategoryCode: 'LUX' }, 'LUX'],
    ['category', { category: 'CMP - Compact' }, 'CMP'],
    ['categoryId', { categoryId: 'MID' }, 'MID'],
  ])('the booked code falls back through %s', async (_label, over, expected) => {
    install(seed({ BookingsNew: [booking(over)] }));
    expect(row(await board()).bookedCategoryCode).toBe(expected);
  });

  test('the booked code prefers the assigned code over the booked category', async () => {
    // Testing each field on its own proves the fallback but not the order, and
    // the order is what decides which code a row shows when a booking was moved
    // to a different category than it was booked in.
    install(seed({
      BookingsNew: [booking({ assignedCategoryCode: 'LUX', category: 'CMP - Compact', categoryId: 'MID' })],
    }));
    expect(row(await board()).bookedCategoryCode).toBe('LUX');
  });

  test('the booked code prefers the category over the raw category id', async () => {
    install(seed({
      BookingsNew: [booking({ assignedCategoryCode: '', category: 'CMP - Compact', categoryId: 'MID' })],
    }));
    expect(row(await board()).bookedCategoryCode).toBe('CMP');
  });

  test('the source falls back through the channel fields', async () => {
    install(seed({ BookingsNew: [booking({ source: '', channel: 'Partner Site' })] }));
    expect(row(await board()).source).toBe('Partner Site');
  });

  test('a booking with no source at all reads as Unknown', async () => {
    install();
    expect(row(await board()).source).toBe('Unknown');
  });
});

describe('setBookingBoardStatus', () => {
  const setStatus = async (newStatus, over = {}) => setBookingBoardStatus({
    authToken: await token(), bookingId: 'bk-1', newStatus, ...over,
  });

  test.each([['Pending'], ['Hold'], ['Escalated']])('%s is written straight through', async (status) => {
    install();
    const result = await setStatus(status);
    expect(result.success).toBe(true);
    expect(bookingRow().status).toBe(status);
  });

  test.each([
    ['an unknown status', 'Obliterated'],
    ['a lowercase variant of a real status', 'confirmed'],
    ['an empty status', ''],
  ])('%s is refused and nothing is written', async (_label, status) => {
    // The set is exact: the board writes the stored value verbatim, and a
    // near-miss would create a status nothing else in the system matches on.
    install();
    const result = await setStatus(status);
    expect(result.success).toBe(false);
    expect(bookingRow().status).toBe('Pending');
    expect(bookingWrites()).toHaveLength(0);
  });

  test('a missing booking id is refused', async () => {
    install();
    const result = await setStatus('Hold', { bookingId: '' });
    expect(result).toMatchObject({ success: false, message: 'Missing params' });
  });

  test('a status change stamps when it happened', async () => {
    install();
    await setStatus('Hold');
    expect(new Date(bookingRow().statusChangedAt).toISOString()).toBe(NOW);
  });

  test('the write passes suppressAuth as the options argument', async () => {
    install();
    await setStatus('Hold');
    const write = bookingWrites().at(-1);
    expect(write.options).toEqual({ suppressAuth: true });
    expect(write.item.suppressAuth).toBeUndefined();
  });
});

describe('confirming a booking', () => {
  const confirm = async (over = {}) => setBookingBoardStatus({
    authToken: await token(), bookingId: 'bk-1', newStatus: 'Confirmed', ...over,
  });

  test('auto-assignment runs before the status is recorded', async () => {
    install();
    const result = await confirm();
    expect(confirmAndAutoAssign).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, message: 'Booking confirmed & vehicle assigned' });
    expect(bookingRow().status).toBe('Confirmed');
  });

  test('a failed auto-assignment leaves the booking unconfirmed', async () => {
    // The whole point of routing Confirmed through fleetCalendar: a booking
    // marked confirmed with no car behind it is worse than one still pending.
    install();
    confirmAndAutoAssign.mockResolvedValueOnce({ success: false, message: 'No vehicle free' });
    const result = await confirm();
    expect(result).toMatchObject({ success: false, message: 'No vehicle free' });
    expect(bookingRow().status).toBe('Pending');
    expect(bookingWrites()).toHaveLength(0);
  });

  test('confirming without an assignment still succeeds, with a plainer message', async () => {
    install();
    confirmAndAutoAssign.mockResolvedValueOnce({ success: true, assigned: false });
    const result = await confirm();
    expect(result).toMatchObject({ success: true, message: 'Booking confirmed' });
    expect(bookingRow().status).toBe('Confirmed');
  });

  test('confirming an already-confirmed booking is a no-op', async () => {
    // Two operators on the same screen must not each trigger an assignment.
    install(seed({ BookingsNew: [booking({ status: 'Confirmed' })] }));
    const result = await confirm();
    expect(result).toMatchObject({ success: true, noOp: true });
    expect(confirmAndAutoAssign).not.toHaveBeenCalled();
    expect(bookingWrites()).toHaveLength(0);
  });

  test('the confirmation timestamp is set on first confirm', async () => {
    install();
    await confirm();
    expect(new Date(bookingRow().confirmedAt).toISOString()).toBe(NOW);
  });

  test('an existing confirmation timestamp is not overwritten', async () => {
    // The booking was confirmed, cancelled, and confirmed again; the original
    // confirmation time is what reporting counts from.
    install(seed({
      BookingsNew: [booking({ status: 'Canceled', confirmedAt: '2026-03-01T08:00:00.000Z' })],
    }));
    await confirm();
    expect(new Date(bookingRow().confirmedAt).toISOString()).toBe('2026-03-01T08:00:00.000Z');
    expect(new Date(bookingRow().statusChangedAt).toISOString()).toBe(NOW);
  });
});

describe('cancelling a booking', () => {
  const cancel = async (email = ADMIN) => setBookingBoardStatus({
    authToken: await token(email), bookingId: 'bk-1', newStatus: 'Canceled',
  });

  test('an admin may cancel', async () => {
    install();
    const result = await cancel();
    expect(result.success).toBe(true);
    expect(bookingRow().status).toBe('Canceled');
  });

  test('a cancellation is stamped with its own timestamp', async () => {
    install();
    await cancel();
    expect(new Date(bookingRow().canceledAt).toISOString()).toBe(NOW);
  });

  test('editing bookings is not enough to cancel one', async () => {
    // The editor role has bookingsEdit but not the cancelBooking special
    // permission, so it can hold and escalate but not cancel.
    install();
    const result = await cancel(EDITOR);
    expect(result.success).toBe(false);
    expect(bookingRow().status).toBe('Pending');
    expect(bookingWrites()).toHaveLength(0);
  });

  test('the same editor may still change other statuses', async () => {
    // The converse, so the test above is about the cancel permission rather
    // than about the role being locked out entirely.
    install();
    const result = await setBookingBoardStatus({
      authToken: await token(EDITOR), bookingId: 'bk-1', newStatus: 'Hold',
    });
    expect(result.success).toBe(true);
    expect(bookingRow().status).toBe('Hold');
  });

  test('a role granted cancelBooking may cancel', async () => {
    install(seed({
      StaffRoles: [{
        _id: 'role-editor', key: 'editor', label: 'Editor', active: true,
        bookingsView: true, bookingsEdit: true, specialPermissions: 'cancelBooking',
      }],
      StaffUsers: [{ _id: 'user-editor', email: EDITOR, fullName: 'Editor', roleKey: 'editor', active: true }],
      StaffCredentials: [credential(EDITOR)],
    }));
    const result = await cancel(EDITOR);
    expect(result.success).toBe(true);
    expect(bookingRow().status).toBe('Canceled');
  });

  test('an unknown booking fails without throwing out of the handler', async () => {
    install();
    const result = await setBookingBoardStatus({
      authToken: await token(), bookingId: 'nope', newStatus: 'Hold',
    });
    expect(result.success).toBe(false);
    expect(bookingWrites()).toHaveLength(0);
  });
});
