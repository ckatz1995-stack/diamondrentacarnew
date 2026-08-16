import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import { getFleetCalendarData, acknowledgeUnassignedInRange } from '../fleetCalendar.jsw';

// The read side of the fleet calendar: the query that decides which bookings are
// in view, and the transform that turns fleet rows into timeline groups and
// bookings into timeline items. fleetHeatmap covers buildHeatmap and
// fleetAssignment covers the write side; neither loads the board itself.
//
// Everything asserted here is data, not markup. Each group carries the fields a
// dispatcher acts on — most importantly `assignable`, which decides whether a
// booking can be dropped onto that vehicle — alongside an HTML `content` string
// for the timeline widget. The HTML is presentation and is left alone; the
// fields are behaviour.

const STAFF = 'staff@example.com';
const PASSWORD = 'correct-horse-battery';
const FROM = '2026-03-10T00:00:00.000Z';
const TO = '2026-03-17T00:00:00.000Z';

function vehicle(over = {}) {
  return {
    _id: 'car-1', plate: 'AAA-1111', model: 'Aygo', category: 'ECO',
    active: true, ready: true, operationalStatus: 'Ready', hardHold: false,
    ...over,
  };
}

function booking(over = {}) {
  return {
    _id: 'bk-1',
    bookingNumber: 'RNT-2026-0001',
    status: 'Confirmed',
    customerName: 'A Customer',
    categoryId: 'ECO',
    pickupDateTime: '2026-03-11T09:00:00.000Z',
    dropoffDateTime: '2026-03-14T09:00:00.000Z',
    assignedVehicle: 'car-1',
    ...over,
  };
}

function seed(extra = {}) {
  const passwordSalt = randomHex(16);
  return {
    StaffRoles: [{ _id: 'role-admin', key: 'admin', label: 'Administrator', active: true }],
    StaffUsers: [{ _id: 'user-1', email: STAFF, fullName: 'Staff', roleKey: 'admin', active: true }],
    StaffCredentials: [{
      _id: 'cred-1', email: STAFF, passwordSalt,
      passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true,
    }],
    StaffSessions: [],
    StaffAuditLog: [],
    FleetNew: [vehicle()],
    BookingsNew: [booking()],
    ...extra,
  };
}

let fake;
function install(s = seed()) {
  fake = createFakeWixData(s).install(wixData);
  return fake;
}
async function token() {
  const { sessionToken } = await loginStaff({ email: STAFF, password: PASSWORD });
  return sessionToken;
}
const board = async (over = {}) => getFleetCalendarData({ authToken: await token(), from: FROM, to: TO, ...over });

// Groups come in two kinds: a parent per category (id `cat_X`) and one per
// vehicle (id = the vehicle's own _id).
const vehicleGroups = (result) => result.groups.filter((g) => !String(g.id).startsWith('cat_') && g.id !== 'unassigned');
const categoryGroups = (result) => result.groups.filter((g) => String(g.id).startsWith('cat_'));
const groupFor = (result, id) => result.groups.find((g) => g.id === id);

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('auth gating', () => {
  const CALLS = [
    ['getFleetCalendarData', getFleetCalendarData],
    ['acknowledgeUnassignedInRange', acknowledgeUnassignedInRange],
  ];

  test.each(CALLS)('%s refuses a missing token', async (_n, fn) => {
    install();
    await expect(fn({ from: FROM, to: TO })).rejects.toThrow('AUTH_REQUIRED');
  });

  test.each(CALLS)('%s refuses a bogus token', async (_n, fn) => {
    install();
    await expect(fn({ authToken: 'made-up', from: FROM, to: TO })).rejects.toThrow('AUTH_REQUIRED');
  });
});

describe('which vehicles appear', () => {
  test('an active vehicle gets a row', async () => {
    install();
    expect(vehicleGroups(await board()).map((g) => g.id)).toEqual(['car-1']);
  });

  test('an inactive vehicle does not', async () => {
    // It cannot be assigned, so a row for it is a row a dispatcher can drop a
    // booking onto by mistake.
    install(seed({ FleetNew: [vehicle(), vehicle({ _id: 'car-2', plate: 'BBB-2222', active: false })] }));
    expect(vehicleGroups(await board()).map((g) => g.id)).toEqual(['car-1']);
  });

  test('vehicles are grouped under their category', async () => {
    install(seed({
      FleetNew: [vehicle(), vehicle({ _id: 'car-2', plate: 'BBB-2222', category: 'CMP' })],
    }));
    expect(categoryGroups(await board()).map((g) => g.id)).toEqual(['cat_CMP', 'cat_ECO', 'cat_Unassigned']);
  });

  test('a vehicle with no category falls into Other', async () => {
    install(seed({ FleetNew: [vehicle({ category: '' })] }));
    expect(categoryGroups(await board()).map((g) => g.id)).toContain('cat_Other');
  });

  test('Other sorts after the real categories', async () => {
    // Sorted by code, so an uncategorised bucket would otherwise land in
    // alphabetical position and push part of the real fleet below it.
    //
    // SUV is here deliberately: it sorts after "Other" alphabetically, so a
    // list of only CMP/ECO/Other would pass whether or not the code special-
    // cases Other, and prove nothing.
    install(seed({
      FleetNew: [
        vehicle({ _id: 'car-x', plate: 'XXX-0000', category: '' }),
        vehicle({ _id: 'car-s', plate: 'SSS-5555', category: 'SUV' }),
        vehicle({ _id: 'car-2', plate: 'BBB-2222', category: 'CMP' }),
        vehicle(),
      ],
    }));
    const codes = categoryGroups(await board()).map((g) => g.id).filter((id) => id !== 'cat_Unassigned');
    expect(codes).toEqual(['cat_CMP', 'cat_ECO', 'cat_SUV', 'cat_Other']);
  });

  test('vehicles inside a category are ordered by plate', async () => {
    install(seed({
      FleetNew: [
        vehicle({ _id: 'car-c', plate: 'CCC-3333' }),
        vehicle({ _id: 'car-a', plate: 'AAA-1111' }),
        vehicle({ _id: 'car-b', plate: 'BBB-2222' }),
      ],
    }));
    expect(vehicleGroups(await board()).map((g) => g.plate)).toEqual(['AAA-1111', 'BBB-2222', 'CCC-3333']);
  });

  test('the parent category lists its vehicles as nested groups', async () => {
    install(seed({ FleetNew: [vehicle(), vehicle({ _id: 'car-2', plate: 'BBB-2222' })] }));
    expect(groupFor(await board(), 'cat_ECO').nestedGroups).toEqual(['car-1', 'car-2']);
  });

  test('the unassigned queue always exists, even with an empty fleet', async () => {
    // It is where a booking with no vehicle is shown; without it those bookings
    // have nowhere to appear.
    install(seed({ FleetNew: [], BookingsNew: [] }));
    const result = await board();
    expect(groupFor(result, 'cat_Unassigned')).toBeDefined();
    expect(groupFor(result, 'unassigned')).toBeDefined();
  });
});

describe('whether a vehicle can be assigned', () => {
  const assignableOf = async (over) => {
    install(seed({ FleetNew: [vehicle(over)] }));
    return groupFor(await board(), 'car-1').assignable;
  };

  test('a ready, unheld, unblocked vehicle is assignable', async () => {
    expect(await assignableOf({})).toBe(true);
  });

  test.each([
    ['a hard hold', { hardHold: true }],
    ['a hard hold recorded as a string', { hardHold: 'true' }],
    ['an operational status of Service', { operationalStatus: 'Service' }],
    ['an operational status of Blocked', { operationalStatus: 'Blocked' }],
    ['an operational status of Inactive', { operationalStatus: 'Inactive' }],
    ['not being ready', { ready: false }],
  ])('%s makes it unassignable', async (_label, over) => {
    expect(await assignableOf(over)).toBe(false);
  });

  test('the reasons are surfaced individually, not just as one flag', async () => {
    // The board shows why a vehicle is unavailable, so each condition has to
    // survive as its own field rather than collapsing into `assignable`.
    install(seed({ FleetNew: [vehicle({ hardHold: true, operationalStatus: 'Blocked' })] }));
    const group = groupFor(await board(), 'car-1');
    expect(group.hardHold).toBe(true);
    expect(group.serviceBlocked).toBe(true);
    expect(group.assignable).toBe(false);
  });

  test('an unknown operational status does not block the vehicle', async () => {
    // Only the three listed states mean blocked; anything else is a note.
    expect(await assignableOf({ operationalStatus: 'Washed' })).toBe(true);
  });
});

describe('which bookings are in view', () => {
  // The query is the database form of the overlap rule in
  // backend/availability.js: pickup < windowEnd AND dropoff > windowStart.
  const idsFor = async (bookings) => {
    install(seed({ BookingsNew: bookings }));
    return (await board()).items.map((i) => i.id);
  };

  test('a booking inside the window is shown', async () => {
    expect(await idsFor([booking()])).toEqual(['bk-1']);
  });

  test.each([
    ['starting before and ending inside', '2026-03-05T09:00:00.000Z', '2026-03-12T09:00:00.000Z', true],
    ['starting inside and ending after', '2026-03-15T09:00:00.000Z', '2026-03-20T09:00:00.000Z', true],
    ['spanning the whole window', '2026-03-01T09:00:00.000Z', '2026-03-25T09:00:00.000Z', true],
    ['entirely before', '2026-03-01T09:00:00.000Z', '2026-03-05T09:00:00.000Z', false],
    ['entirely after', '2026-03-20T09:00:00.000Z', '2026-03-25T09:00:00.000Z', false],
    ['ending exactly at the window start', '2026-03-05T09:00:00.000Z', FROM, false],
    ['starting exactly at the window end', TO, '2026-03-20T09:00:00.000Z', false],
  ])('a booking %s is %s in view', async (_label, pickup, dropoff, shown) => {
    const ids = await idsFor([booking({ pickupDateTime: pickup, dropoffDateTime: dropoff })]);
    expect(ids.includes('bk-1')).toBe(shown);
  });

  test('a cancelled booking is left off the board', async () => {
    // It does not hold a vehicle, so showing it would make the fleet look
    // busier than it is.
    expect(await idsFor([booking({ status: 'Canceled' })])).toEqual([]);
  });

  test.each([
    ['no pickup date', { pickupDateTime: null }],
    ['no dropoff date', { dropoffDateTime: null }],
    ['an unparseable pickup date', { pickupDateTime: 'sometime' }],
  ])('a booking with %s is skipped rather than breaking the board', async (_label, over) => {
    install(seed({ BookingsNew: [booking(over), booking({ _id: 'bk-ok' })] }));
    const result = await board();
    expect(result.items.map((i) => i.id)).toEqual(['bk-ok']);
  });
});

describe('where a booking is placed', () => {
  test('an assigned booking is placed on its vehicle', async () => {
    install();
    const [item] = (await board()).items;
    expect(item.group).toBe('car-1');
    expect(item.resource).toBe('car-1'); // some frontends read one, some the other
  });

  test('an unassigned booking goes to the unassigned queue', async () => {
    install(seed({ BookingsNew: [booking({ assignedVehicle: '' })] }));
    const result = await board();
    expect(result.unassigned.map((i) => i.id)).toEqual(['bk-1']);
    expect(result.items.map((i) => i.id)).toEqual(['bk-1']); // and still on the board
  });

  test('an assigned booking is not in the unassigned queue', async () => {
    install();
    expect((await board()).unassigned).toEqual([]);
  });

  test('a booking carries its start and end as ISO strings', async () => {
    install();
    const [item] = (await board()).items;
    expect(item.start).toBe('2026-03-11T09:00:00.000Z');
    expect(item.end).toBe('2026-03-14T09:00:00.000Z');
  });

  test('a booking carries the details a dispatcher needs to identify it', async () => {
    install();
    const [item] = (await board()).items;
    expect(item.bookingNumber).toBe('RNT-2026-0001');
    expect(item.customerName).toBe('A Customer');
    expect(item.status).toBe('Confirmed');
  });

  test('a booking with no rental state reads as a plain booking', async () => {
    install();
    expect((await board()).items[0].rentalState).toBe('Booking');
  });
});

describe('the default window', () => {
  test('covers from today to a fortnight out when no range is given', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-03-10T12:00:00Z'));
      install(seed({
        BookingsNew: [
          booking({ _id: 'bk-soon', pickupDateTime: '2026-03-12T09:00:00.000Z', dropoffDateTime: '2026-03-13T09:00:00.000Z' }),
          booking({ _id: 'bk-far', pickupDateTime: '2026-04-20T09:00:00.000Z', dropoffDateTime: '2026-04-22T09:00:00.000Z' }),
        ],
      }));
      const result = await getFleetCalendarData({ authToken: await token() });
      expect(result.items.map((i) => i.id)).toEqual(['bk-soon']);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('acknowledging unassigned bookings', () => {
  test('counts the bookings with no vehicle in the window', async () => {
    install(seed({
      BookingsNew: [
        booking({ _id: 'bk-none', assignedVehicle: '' }),
        booking({ _id: 'bk-none-2', assignedVehicle: '' }),
        booking({ _id: 'bk-assigned' }),
      ],
    }));
    const result = await acknowledgeUnassignedInRange({ authToken: await token(), from: FROM, to: TO });
    expect(result).toMatchObject({ success: true, total: 2 });
  });

  test('a cancelled booking is not counted as needing a vehicle', async () => {
    install(seed({
      BookingsNew: [booking({ _id: 'bk-gone', assignedVehicle: '', status: 'Canceled' })],
    }));
    expect((await acknowledgeUnassignedInRange({ authToken: await token(), from: FROM, to: TO })).total).toBe(0);
  });

  test('KNOWN GAP: it reports success and acknowledges nothing', async () => {
    // The loop that would stamp the bookings is commented out in the source, so
    // this counts and returns without writing. A caller cannot tell the
    // difference: `success: true` with a non-zero `total` reads like work was
    // done, and calling it again returns the same total forever.
    //
    // Pinned rather than changed — what an acknowledgement should record is a
    // product decision, and inventing fields here would be guessing.
    install(seed({
      BookingsNew: [booking({ _id: 'bk-none', assignedVehicle: '' })],
    }));
    const before = fake.rows('BookingsNew');
    const result = await acknowledgeUnassignedInRange({ authToken: await token(), from: FROM, to: TO });

    expect(result).toMatchObject({ success: true, total: 1, updated: 0 });
    expect(fake.calls.update.filter((c) => c.collection === 'BookingsNew')).toHaveLength(0);
    expect(fake.rows('BookingsNew')).toEqual(before);
  });
});
