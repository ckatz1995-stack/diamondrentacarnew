import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import { getFleetCalendarData } from '../fleetCalendar.jsw';

// What each card on the fleet calendar says.
//
// fleetCalendarData covers which vehicles and bookings reach the board and
// whether a vehicle is assignable. This covers what buildGroups and buildItems
// then compose out of them: the label, the hover title, and the dozen or so
// aliased fields a booking can arrive under. That was the module's remaining
// branch gap — it sat at 98% statements and 70% branches, because a fallback
// chain is one statement and several decisions.
//
// A dispatcher reads these strings to decide where a car goes, so a silently
// blank one is a real failure, not a cosmetic one.

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
const board = async () => getFleetCalendarData({ authToken: await token(), from: FROM, to: TO });

/** The single booking card, with the given fields varied. */
async function card(over) {
  install(seed({ BookingsNew: [booking(over)] }));
  const res = await board();
  return res.items.find((i) => i.id === 'bk-1');
}

/** The single vehicle row, with the given fields varied. */
async function row(over) {
  install(seed({ FleetNew: [vehicle(over)] }));
  const res = await board();
  return res.groups.find((g) => g.id === 'car-1');
}

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('the label on a booking card', () => {
  test('reads number, category and status', async () => {
    expect((await card({})).text).toBe('RNT-2026-0001 • ECO • Confirmed');
  });

  test('drops the category when the booking has none', async () => {
    expect((await card({ categoryId: '', category: '' })).text).toBe('RNT-2026-0001 • Confirmed');
  });

  test('drops the status when the booking has none', async () => {
    expect((await card({ status: '' })).text).toBe('RNT-2026-0001 • ECO');
  });

  test('is just the number when there is nothing else', async () => {
    expect((await card({ categoryId: '', category: '', status: '' })).text).toBe('RNT-2026-0001');
  });

  test('the number falls back to the record title, then to the id', async () => {
    expect((await card({ bookingNumber: '', title: 'Walk-in 14:00' })).bookingNumber).toBe('Walk-in 14:00');
    expect((await card({ bookingNumber: '', title: '' })).bookingNumber).toBe('bk-1');
  });

  test('the category label falls back from categoryId to category', async () => {
    expect((await card({ categoryId: 'ECO', category: 'SUV' })).category).toBe('ECO');
    expect((await card({ categoryId: '', category: 'SUV' })).category).toBe('SUV');
    expect((await card({ categoryId: '', category: '' })).category).toBe('');
  });

  test('a category held as an object is read for its title', async () => {
    expect((await card({ categoryId: { title: 'Economy', code: 'ECO' } })).category).toBe('Economy');
  });

  test('the short code is derived from whatever label was found', async () => {
    expect((await card({ categoryId: 'ECO - Economy' })).bookedCategoryCode).toBe('ECO');
  });

  test('the same string is used for name as for text, since frontends differ', async () => {
    const c = await card({});
    expect(c.name).toBe(c.text);
  });
});

describe('the hover title on a booking card', () => {
  const lines = async (over) => (await card(over)).title.split('\n');

  test('names the booking, the customer, the window and the vehicle', async () => {
    const [no, customer, window_, vehicleLine] = await lines({
      assignedVehiclePlate: 'AAA-1111', assignedVehicleModel: 'Aygo',
    });
    expect(no).toBe('RNT-2026-0001');
    expect(customer).toBe('A Customer');
    expect(window_).toBe('2026-03-11 09:00 → 2026-03-14 09:00');
    expect(vehicleLine).toBe('AAA-1111 • Aygo');
  });

  test('says Booking when there is no number at all', async () => {
    // Looked up positionally rather than by id: this is the one fixture with no
    // id of its own, which is exactly what makes the bookingNumber empty.
    install(seed({ BookingsNew: [booking({ bookingNumber: '', title: '', _id: '' })] }));
    const res = await board();
    expect(res.items[0].bookingNumber).toBe('');
    expect(res.items[0].title.split('\n')[0]).toBe('Booking');
  });

  test('says an em dash when there is no customer', async () => {
    const [, customer] = await lines({ customerName: '' });
    expect(customer).toBe('—');
  });

  test('says Unassigned when no vehicle is attached', async () => {
    const [, , , vehicleLine] = await lines({ assignedVehicle: '' });
    expect(vehicleLine).toBe('Unassigned');
  });

  test('joins source and agent when both are present', async () => {
    const [, , , , provenance] = await lines({ source: 'Booking.com', agent: 'Maria' });
    expect(provenance).toBe('Booking.com • Maria');
  });

  test('shows either one alone without a stray separator', async () => {
    expect((await lines({ source: 'Booking.com', agent: '' }))[4]).toBe('Booking.com');
    expect((await lines({ source: '', agent: 'Maria' }))[4]).toBe('Maria');
  });

  test('is blank on that line when neither is known', async () => {
    expect((await lines({ source: '', agent: '' }))[4]).toBe('');
  });
});

describe('the vehicle a booking card points at', () => {
  test('uses the stored label when there is one', async () => {
    const c = await card({ assignedVehicleLabel: 'AAA-1111 (reserved)', assignedVehiclePlate: 'AAA-1111', assignedVehicleModel: 'Aygo' });
    expect(c.assignedVehicleLabel).toBe('AAA-1111 (reserved)');
  });

  test('composes one from the plate and model when there is not', async () => {
    const c = await card({ assignedVehiclePlate: 'AAA-1111', assignedVehicleModel: 'Aygo' });
    expect(c.assignedVehicleLabel).toBe('AAA-1111 • Aygo');
  });

  test('falls back to whichever half exists', async () => {
    expect((await card({ assignedVehiclePlate: 'AAA-1111' })).assignedVehicleLabel).toBe('AAA-1111');
    expect((await card({ assignedVehicleModel: 'Aygo' })).assignedVehicleLabel).toBe('Aygo');
  });

  test('is empty when neither is known', async () => {
    expect((await card({})).assignedVehicleLabel).toBe('');
  });

  test('resource and group carry the same vehicle id, for either timeline widget', async () => {
    const c = await card({});
    expect(c.resource).toBe('car-1');
    expect(c.group).toBe('car-1');
    expect(c.assignedFleetId).toBe('car-1');
  });

  test('a placeholder assignment counts as unassigned', async () => {
    // refId treats the strings "unassigned", "null" and "undefined" as empty,
    // which is what stops a placeholder written by an import from looking like
    // a real vehicle the booking is sitting on.
    for (const placeholder of ['unassigned', 'null', 'undefined', 'UNASSIGNED']) {
      const c = await card({ assignedVehicle: placeholder });
      expect(c.resource).toBe('');
      expect(c.assignedFleetId).toBe('');
    }
  });

  test('an unassigned booking appears in the unassigned list as well as the items', async () => {
    install(seed({ BookingsNew: [booking({ assignedVehicle: '' })] }));
    const res = await board();
    expect(res.unassigned.map((i) => i.id)).toEqual(['bk-1']);
    expect(res.items.map((i) => i.id)).toEqual(['bk-1']);
  });

  test('an assigned booking is not in the unassigned list', async () => {
    install();
    const res = await board();
    expect(res.unassigned).toEqual([]);
  });
});

describe('the aliased fields a booking can arrive under', () => {
  test('source and agent read either capitalisation', async () => {
    expect((await card({ Source: 'Expedia' })).source).toBe('Expedia');
    expect((await card({ Agent: 'Nikos' })).agent).toBe('Nikos');
  });

  test('the lower-case spelling wins when both are stored', async () => {
    expect((await card({ source: 'Direct', Source: 'Expedia' })).source).toBe('Direct');
  });

  test('the flight number reads three spellings', async () => {
    expect((await card({ flightNumber: 'A3 610' })).flightNumber).toBe('A3 610');
    expect((await card({ FlightNumber: 'A3 611' })).flightNumber).toBe('A3 611');
    expect((await card({ flightNo: 'A3 612' })).flightNumber).toBe('A3 612');
  });

  test('remarks fall through four fields in order', async () => {
    expect((await card({ remarks: 'r', internalMemo: 'm', pickupComment: 'p', dropoffComment: 'd' })).remarks).toBe('r');
    expect((await card({ internalMemo: 'm', pickupComment: 'p', dropoffComment: 'd' })).remarks).toBe('m');
    expect((await card({ pickupComment: 'p', dropoffComment: 'd' })).remarks).toBe('p');
    expect((await card({ dropoffComment: 'd' })).remarks).toBe('d');
    expect((await card({})).remarks).toBe('');
  });

  test('the package reads either name', async () => {
    expect((await card({ selectedPackage: 'Full' })).selectedPackage).toBe('Full');
    expect((await card({ package: 'Basic' })).selectedPackage).toBe('Basic');
  });

  test('extras given as a list are kept as one', async () => {
    const c = await card({ selectedExtrasList: ['gps', 'seat'] });
    expect(c.selectedExtrasList).toEqual(['gps', 'seat']);
    expect(c.extras).toBe('gps, seat');
  });

  test('extras given as a comma string are split and trimmed', async () => {
    const c = await card({ extras: ' gps , seat ,, ' });
    expect(c.selectedExtrasList).toEqual(['gps', 'seat']);
    expect(c.extras).toBe('gps, seat');
  });

  test('no extras gives an empty list and an empty string', async () => {
    const c = await card({});
    expect(c.selectedExtrasList).toEqual([]);
    expect(c.extras).toBe('');
  });

  test('the pickup and dropoff points are exposed under both casings', async () => {
    const c = await card({ pickuppoint: 'Airport', dropoffpoint: 'Office' });
    expect(c.pickupPoint).toBe('Airport');
    expect(c.pickuppoint).toBe('Airport');
    expect(c.dropoffPoint).toBe('Office');
    expect(c.dropoffpoint).toBe('Office');
  });

  test('the rental state defaults to Booking', async () => {
    expect((await card({})).rentalState).toBe('Booking');
    expect((await card({ rentalState: 'Active Rental' })).rentalState).toBe('Active Rental');
  });
});

describe('which bookings become cards at all', () => {
  test('a booking with an unparseable date is skipped rather than placed wrongly', async () => {
    install(seed({ BookingsNew: [booking({ pickupDateTime: 'sometime' })] }));
    expect((await board()).items).toEqual([]);
  });

  test('a booking missing a date entirely is skipped', async () => {
    install(seed({ BookingsNew: [booking({ dropoffDateTime: null })] }));
    expect((await board()).items).toEqual([]);
  });

  test('a cancelled booking is skipped', async () => {
    install(seed({ BookingsNew: [booking({ status: 'Canceled' })] }));
    expect((await board()).items).toEqual([]);
  });
});

describe('the label on a vehicle row', () => {
  test('joins plate and model', async () => {
    expect((await row({})).title.split('\n')[0]).toBe('AAA-1111 • Aygo');
  });

  test('is the plate alone when there is no model', async () => {
    expect((await row({ model: '' })).title.split('\n')[0]).toBe('AAA-1111');
  });

  test('falls back to the record id when there is no plate', async () => {
    expect((await row({ plate: '' })).plate).toBe('car-1');
  });
});

describe('the hover title on a vehicle row', () => {
  const titleOf = async (over) => (await row(over)).title;

  test('names the category', async () => {
    expect(await titleOf({})).toContain('Category: ECO');
  });

  test('names the station, preferring the label over the code over the plain field', async () => {
    expect(await titleOf({ currentStationLabel: 'Athens T1', currentStationCode: 'ATH', station: 'Depot' }))
      .toContain('Station: Athens T1');
    expect(await titleOf({ currentStationCode: 'ATH', station: 'Depot' })).toContain('Station: ATH');
    expect(await titleOf({ station: 'Depot' })).toContain('Station: Depot');
  });

  test('omits the station line when no station is known', async () => {
    expect(await titleOf({})).not.toContain('Station:');
  });

  test('names the mileage when it is recorded', async () => {
    expect(await titleOf({ mileage: 41230 })).toContain('Mileage: 41230');
    expect(await titleOf({})).not.toContain('Mileage:');
  });

  test('names the readiness, but not when it is unknown', async () => {
    expect(await titleOf({ ready: true })).toContain('Ready: Ready');
    expect(await titleOf({ ready: false })).toContain('Ready: Not ready');
    // yesNo turns an unset flag into an em dash, which is not worth a line.
    expect(await titleOf({ ready: '' })).not.toContain('Ready:');
  });

  test('names the stall when it is recorded', async () => {
    expect(await titleOf({ stall: 'B7' })).toContain('Stall: B7');
    expect(await titleOf({})).not.toContain('Stall:');
  });

  test('names the operational status when it is recorded', async () => {
    expect(await titleOf({ operationalStatus: 'Service' })).toContain('Operational: Service');
    expect(await titleOf({ operationalStatus: '' })).not.toContain('Operational:');
  });

  test('calls out a hard hold, and stays silent when there is none', async () => {
    expect(await titleOf({ hardHold: true })).toContain('Hard hold: Yes');
    expect(await titleOf({ hardHold: false })).not.toContain('Hard hold');
  });

  test('carries no blank lines, however little is known about the vehicle', async () => {
    // Every other assertion here uses toContain, which cannot see an extra empty
    // line. The title is joined with newlines and rendered as a tooltip, so a
    // sparse vehicle without the filter would show as a name followed by a
    // column of blank rows.
    const bare = await row({ model: '', station: '', mileage: '', stall: '', operationalStatus: '', ready: '' });
    expect(bare.title.split('\n')).toEqual(['AAA-1111', 'Category: ECO', 'Assignable: Yes']);
  });

  test('always ends by saying whether the vehicle can be assigned', async () => {
    expect(await titleOf({})).toContain('Assignable: Yes');
    expect(await titleOf({ hardHold: true })).toContain('Assignable: No');
    expect(await titleOf({ operationalStatus: 'Service' })).toContain('Assignable: No');
    expect(await titleOf({ ready: false })).toContain('Assignable: No');
  });

  test('a hard hold stored as the string "true" counts as one', async () => {
    // Wix checkboxes come back as strings from some import paths.
    const g = await row({ hardHold: 'true' });
    expect(g.hardHold).toBe(true);
    expect(g.assignable).toBe(false);
  });
});

describe('how vehicle rows are grouped and ordered', () => {
  test('vehicles are grouped under their category code', async () => {
    install(seed({ FleetNew: [
      vehicle({ _id: 'car-1', plate: 'AAA-1111', category: 'ECO' }),
      vehicle({ _id: 'car-2', plate: 'BBB-2222', category: 'SUV' }),
    ] }));
    const res = await board();
    expect(res.groups.filter((g) => g.id.startsWith('cat_')).map((g) => g.id))
      .toEqual(['cat_ECO', 'cat_SUV', 'cat_Unassigned']);
  });

  test('a vehicle with no usable category lands under Other', async () => {
    install(seed({ FleetNew: [vehicle({ _id: 'car-1', category: '' })] }));
    const res = await board();
    expect(res.groups.find((g) => g.id === 'car-1').categoryCode).toBe('Other');
  });

  test('Other sorts after the real categories, not alphabetically among them', async () => {
    // Both insertion orders, deliberately. The comparator maps "Other" to "ZZZ"
    // on both sides; a one-sided version is an inconsistent comparator, which
    // still gives the right answer for one of the two orders. Testing only the
    // order where it happens to agree proves nothing.
    for (const fleet of [
      [vehicle({ _id: 'car-1', plate: 'AAA-1111', category: '' }), vehicle({ _id: 'car-2', plate: 'BBB-2222', category: 'SUV' })],
      [vehicle({ _id: 'car-2', plate: 'BBB-2222', category: 'SUV' }), vehicle({ _id: 'car-1', plate: 'AAA-1111', category: '' })],
    ]) {
      install(seed({ FleetNew: fleet }));
      const res = await board();
      expect(res.groups.filter((g) => g.id.startsWith('cat_')).map((g) => g.id))
        .toEqual(['cat_SUV', 'cat_Other', 'cat_Unassigned']);
      fake.restore();
      fake = null;
    }
  });

  test('a vehicle with no category is put under Other by fleetCatCode itself', async () => {
    // The `|| "Other"` at the grouping site is belt-and-braces: fleetCatCode
    // already ends in the same fallback, so removing either one alone changes
    // nothing. Stated so the redundancy is not mistaken for a gap.
    install(seed({ FleetNew: [vehicle({ _id: 'car-1', category: '' })] }));
    const res = await board();
    expect(res.groups.find((g) => g.id === 'car-1').categoryCode).toBe('Other');
  });

  test('vehicles inside a category are ordered by plate', async () => {
    install(seed({ FleetNew: [
      vehicle({ _id: 'car-z', plate: 'ZZZ-9999', category: 'ECO' }),
      vehicle({ _id: 'car-a', plate: 'AAA-1111', category: 'ECO' }),
    ] }));
    const res = await board();
    const eco = res.groups.find((g) => g.id === 'cat_ECO');
    expect(eco.nestedGroups).toEqual(['car-a', 'car-z']);
  });

  test('rows are striped in the order they end up in', async () => {
    install(seed({ FleetNew: [
      vehicle({ _id: 'car-z', plate: 'ZZZ-9999', category: 'ECO' }),
      vehicle({ _id: 'car-a', plate: 'AAA-1111', category: 'ECO' }),
    ] }));
    const res = await board();
    expect(res.groups.find((g) => g.id === 'car-a').className).toBe('fleetRowEven');
    expect(res.groups.find((g) => g.id === 'car-z').className).toBe('fleetRowOdd');
  });

  test('the unassigned queue is always present, even with no bookings', async () => {
    install(seed({ BookingsNew: [] }));
    const res = await board();
    expect(res.groups.map((g) => g.id)).toContain('unassigned');
    expect(res.groups.map((g) => g.id)).toContain('cat_Unassigned');
  });
});
