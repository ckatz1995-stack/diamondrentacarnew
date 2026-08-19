import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import { getContract } from '../rentalContract.jsw';

// The lookups half of getContract: the vehicle selector the operator picks a
// car from, and the customer and company directories behind the autocomplete.
//
// The selector is the interesting part. Every fleet row is classified into one
// of seven states, and the order of those checks is the policy: a vehicle
// already on this booking stays selectable no matter what else is true of it,
// and everything else is refused for the first reason that applies. The tests
// below walk the chain in that order, because a row that qualifies for two
// states must show the more serious one.

const PASSWORD = 'correct-horse-battery';
const ADMIN = 'admin@example.com';
const BOOKING_ID = 'bk-1';

function booking(extra = {}) {
  return {
    _id: BOOKING_ID,
    bookingNumber: 'RNT-2026-0001',
    status: 'Confirmed',
    customerName: 'A Customer',
    email: 'customer@example.com',
    pickupDateTime: '2026-03-10T08:00:00.000Z',
    dropoffDateTime: '2026-03-13T08:00:00.000Z',
    categoryId: 'ECO',
    ...extra,
  };
}

function fleet(extra = {}) {
  return {
    _id: 'f-1', plate: 'AAA-1', model: 'Fiat Panda', categoryCode: 'ECO',
    active: true, status: 'available', operationalStatus: 'available',
    readyToGo: true, hardHold: false,
    ...extra,
  };
}

function seed({ bookingRow = booking(), fleetRows = [fleet()], categories = [], customers = [], companies = [], bookings = [] } = {}) {
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
    RentalsNew: [],
    FleetNew: fleetRows,
    VehiclesNew: categories,
    Customers: customers,
    Companies: companies,
  };
}

let fake;
const install = (options) => { fake = createFakeWixData(seed(options)).install(wixData); return fake; };
const token = async () => (await loginStaff({ email: ADMIN, password: PASSWORD })).sessionToken;
const lookups = async (options) => {
  install(options);
  const res = await getContract({ authToken: await token(), bookingId: BOOKING_ID });
  expect(res.success).toBe(true);
  return res.lookups;
};
const vehicle = (rows, id = 'f-1') => rows.find((v) => v._id === id);

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('a vehicle that is free to take', () => {
  test('is offered as available and assignable', async () => {
    const { vehicles } = await lookups();

    expect(vehicle(vehicles)).toMatchObject({
      selectorStatusKey: 'available',
      selectorStatusLabel: 'Available',
      selectorTone: 'ok',
      assignable: true,
    });
  });

  test('carries the plate, model and category the operator picks by', async () => {
    const { vehicles } = await lookups();

    expect(vehicle(vehicles)).toMatchObject({ plate: 'AAA-1', model: 'Fiat Panda' });
  });
});

describe('the vehicle already on this booking', () => {
  test('is marked as assigned here and stays selectable', async () => {
    const { vehicles } = await lookups({ bookingRow: booking({ assignedVehicle: 'f-1' }) });

    expect(vehicle(vehicles)).toMatchObject({
      selectorStatusKey: 'assignedThis',
      selectorStatusLabel: 'Assigned here',
      selectorTone: 'info',
      assignable: true,
    });
  });

  test.each([
    ['it is out of service', { operationalStatus: 'service' }],
    ['it is under a hard hold', { hardHold: true }],
    ['it is not marked ready', { readyToGo: false }],
    ['it belongs to another station', { currentStationCode: 'SKG' }],
    ['it is flagged inactive', { active: false }],
  ])('stays selectable even when %s', async (_label, extra) => {
    // Otherwise an operator could not re-save a booking whose car has since
    // been grounded — the screen would refuse the assignment already in place.
    const { vehicles } = await lookups({
      bookingRow: booking({ assignedVehicle: 'f-1', pickuppoint: 'ATH Athens' }),
      fleetRows: [fleet(extra)],
    });

    expect(vehicle(vehicles)).toMatchObject({ selectorStatusKey: 'assignedThis', assignable: true });
  });
});

describe('a vehicle that cannot be taken', () => {
  test.each([
    ['operationalStatus service', { operationalStatus: 'service' }],
    ['operationalStatus blocked', { operationalStatus: 'blocked' }],
    ['operationalStatus inactive', { operationalStatus: 'inactive' }],
    ['status service while operationalStatus is fine', { status: 'service', operationalStatus: 'available' }],
    ['active false', { active: false }],
    ['active as the text "false"', { active: 'false' }],
    ['active as the text "no"', { active: 'no' }],
    ['active as the text "0"', { active: '0' }],
  ])('is refused as service/blocked when %s', async (_label, extra) => {
    const { vehicles } = await lookups({ fleetRows: [fleet(extra)] });

    expect(vehicle(vehicles)).toMatchObject({
      selectorStatusKey: 'service',
      selectorStatusLabel: 'Service / blocked',
      selectorTone: 'danger',
      assignable: false,
    });
  });

  test('is refused as a hard hold when it is held but otherwise fine', async () => {
    const { vehicles } = await lookups({ fleetRows: [fleet({ hardHold: true })] });

    expect(vehicle(vehicles)).toMatchObject({
      selectorStatusKey: 'hardHold', selectorTone: 'danger', assignable: false,
    });
  });

  test('reads a hard hold written as text', async () => {
    const { vehicles } = await lookups({ fleetRows: [fleet({ hardHold: 'true' })] });

    expect(vehicle(vehicles).selectorStatusKey).toBe('hardHold');
  });

  test.each([
    ['operationalStatus assigned', { operationalStatus: 'assigned' }],
    ['operationalStatus unavailable', { operationalStatus: 'unavailable' }],
    ['operationalStatus out', { operationalStatus: 'out' }],
  ])('is refused as busy when %s', async (_label, extra) => {
    const { vehicles } = await lookups({ fleetRows: [fleet(extra)] });

    expect(vehicle(vehicles)).toMatchObject({
      selectorStatusKey: 'busy', selectorStatusLabel: 'Busy / conflict', assignable: false,
    });
  });

  test('is refused as busy when another booking holds it over the same window', async () => {
    const { vehicles } = await lookups({
      bookings: [{
        _id: 'bk-2', status: 'Confirmed', assignedVehicle: 'f-1',
        pickupDateTime: '2026-03-11T08:00:00.000Z', dropoffDateTime: '2026-03-12T08:00:00.000Z',
      }],
    });

    expect(vehicle(vehicles)).toMatchObject({ selectorStatusKey: 'busy', assignable: false });
  });

  test('is free again when the clashing booking is cancelled', async () => {
    const { vehicles } = await lookups({
      bookings: [{
        _id: 'bk-2', status: 'Canceled', assignedVehicle: 'f-1',
        pickupDateTime: '2026-03-11T08:00:00.000Z', dropoffDateTime: '2026-03-12T08:00:00.000Z',
      }],
    });

    expect(vehicle(vehicles)).toMatchObject({ selectorStatusKey: 'available', assignable: true });
  });

  test('is free again when the clashing rental is closed', async () => {
    const { vehicles } = await lookups({
      bookings: [{
        _id: 'bk-2', status: 'Confirmed', rentalState: 'Closed Rental', assignedVehicle: 'f-1',
        pickupDateTime: '2026-03-11T08:00:00.000Z', dropoffDateTime: '2026-03-12T08:00:00.000Z',
      }],
    });

    expect(vehicle(vehicles).selectorStatusKey).toBe('available');
  });

  test('is free when the other booking is outside this window', async () => {
    const { vehicles } = await lookups({
      bookings: [{
        _id: 'bk-2', status: 'Confirmed', assignedVehicle: 'f-1',
        pickupDateTime: '2026-05-01T08:00:00.000Z', dropoffDateTime: '2026-05-05T08:00:00.000Z',
      }],
    });

    expect(vehicle(vehicles).selectorStatusKey).toBe('available');
  });

  test('is refused as wrong station when it sits somewhere else', async () => {
    const { vehicles } = await lookups({
      bookingRow: booking({ pickuppoint: 'ATH Athens Airport' }),
      fleetRows: [fleet({ currentStationCode: 'SKG' })],
    });

    expect(vehicle(vehicles)).toMatchObject({
      selectorStatusKey: 'wrongStation', selectorTone: 'warn', assignable: false,
    });
  });

  test('names the station it is actually at, so the operator knows where to look', async () => {
    const { vehicles } = await lookups({
      bookingRow: booking({ pickuppoint: 'ATH Athens Airport' }),
      fleetRows: [fleet({ currentStationCode: 'SKG', currentStationLabel: 'Thessaloniki Port' })],
    });

    expect(vehicle(vehicles).selectorStatusReason).toContain('Thessaloniki Port');
  });

  test('falls back to "another station" when it has no label to name', async () => {
    const { vehicles } = await lookups({
      bookingRow: booking({ pickuppoint: 'ATH Athens Airport' }),
      fleetRows: [fleet({ currentStationCode: 'SKG' })],
    });

    expect(vehicle(vehicles).selectorStatusReason).toContain('SKG');
  });

  test('is refused as not ready when nothing else is wrong with it', async () => {
    const { vehicles } = await lookups({ fleetRows: [fleet({ readyToGo: false })] });

    expect(vehicle(vehicles)).toMatchObject({
      selectorStatusKey: 'notReady', selectorTone: 'warn', assignable: false,
    });
  });

  test('reads readiness written as text', async () => {
    const { vehicles } = await lookups({ fleetRows: [fleet({ readyToGo: 'true' })] });

    expect(vehicle(vehicles).selectorStatusKey).toBe('available');
  });
});

describe('the order the reasons are applied in', () => {
  // Each of these rows qualifies for two states at once. The one reported is
  // the earlier check, which is also the more serious of the two — an operator
  // told "not ready" about a car that is actually out of service would go and
  // tick the ready box.
  test.each([
    ['service beats a hard hold', { operationalStatus: 'service', hardHold: true }, 'service'],
    ['service beats not-ready', { operationalStatus: 'service', readyToGo: false }, 'service'],
    ['a hard hold beats busy', { hardHold: true, operationalStatus: 'assigned' }, 'hardHold'],
    ['busy beats the wrong station', { operationalStatus: 'assigned', currentStationCode: 'SKG' }, 'busy'],
    ['the wrong station beats not-ready', { currentStationCode: 'SKG', readyToGo: false }, 'wrongStation'],
  ])('%s', async (_label, extra, expected) => {
    const { vehicles } = await lookups({
      bookingRow: booking({ pickuppoint: 'ATH Athens Airport' }),
      fleetRows: [fleet(extra)],
    });

    expect(vehicle(vehicles).selectorStatusKey).toBe(expected);
  });
});

describe('how the station is matched', () => {
  test('a booking with no pickup point accepts every station', async () => {
    const { vehicles } = await lookups({ fleetRows: [fleet({ currentStationCode: 'SKG' })] });

    expect(vehicle(vehicles).selectorStatusKey).toBe('available');
  });

  test('a vehicle with no station recorded is accepted anywhere', async () => {
    const { vehicles } = await lookups({
      bookingRow: booking({ pickuppoint: 'ATH Athens Airport' }),
      fleetRows: [fleet({ currentStationCode: '', currentStationLabel: '' })],
    });

    expect(vehicle(vehicles).selectorStatusKey).toBe('available');
  });

  test('matching stations are accepted', async () => {
    const { vehicles } = await lookups({
      bookingRow: booking({ pickuppoint: 'ATH Athens Airport' }),
      fleetRows: [fleet({ currentStationCode: 'ATH' })],
    });

    expect(vehicle(vehicles).selectorStatusKey).toBe('available');
  });

  test('the station label is used when there is no code', async () => {
    const { vehicles } = await lookups({
      bookingRow: booking({ pickuppoint: 'ATH Athens Airport' }),
      fleetRows: [fleet({ currentStationCode: '', currentStationLabel: 'SKG Thessaloniki' })],
    });

    expect(vehicle(vehicles).selectorStatusKey).toBe('wrongStation');
  });

  test('a pickup point that yields no usable code accepts every station', async () => {
    // The code has to look like a station code — two to six letters or digits.
    // Free text that does not is treated as "no preference" rather than as a
    // station nothing can match.
    const { vehicles } = await lookups({
      bookingRow: booking({ pickuppoint: 'somewhere in the city centre please' }),
      fleetRows: [fleet({ currentStationCode: 'SKG' })],
    });

    expect(vehicle(vehicles).selectorStatusKey).toBe('available');
  });
});

describe('the order the vehicles are offered in', () => {
  test('the assigned car first, then the assignable ones, then the excuses', async () => {
    // The assigned car is deliberately given the last plate alphabetically:
    // ordering by state has to beat ordering by label, or the car already on
    // the booking would sink into the middle of the list.
    const { vehicles } = await lookups({
      bookingRow: booking({ assignedVehicle: 'f-mine', pickuppoint: 'ATH Athens Airport' }),
      fleetRows: [
        fleet({ _id: 'f-service', plate: 'CCC-3', operationalStatus: 'service' }),
        fleet({ _id: 'f-busy', plate: 'DDD-4', operationalStatus: 'assigned' }),
        fleet({ _id: 'f-station', plate: 'EEE-5', currentStationCode: 'SKG' }),
        fleet({ _id: 'f-free', plate: 'AAA-1' }),
        fleet({ _id: 'f-mine', plate: 'ZZZ-9' }),
      ],
    });

    expect(vehicles.map((v) => v._id)).toEqual(['f-mine', 'f-free', 'f-station', 'f-busy', 'f-service']);
  });

  test('cars in the same state are listed by label, numerically aware', async () => {
    const { vehicles } = await lookups({
      fleetRows: [
        fleet({ _id: 'f-10', plate: 'AAA-10' }),
        fleet({ _id: 'f-2', plate: 'AAA-2' }),
        fleet({ _id: 'f-1', plate: 'AAA-1' }),
      ],
    });

    expect(vehicles.map((v) => v._id)).toEqual(['f-1', 'f-2', 'f-10']);
  });

  // Mutation note: the exclusion of the booking's own row inside
  // findBusyAssignedVehicleIds cannot be observed from here. The only vehicle
  // that row could mark busy is the one already assigned to this booking, and
  // that vehicle is classified as 'assignedThis' before the busy check runs.
  test('a fleet row with no id is left out entirely', async () => {
    const { vehicles } = await lookups({ fleetRows: [fleet(), { plate: 'NO-ID', model: 'Ghost' }] });

    expect(vehicles).toHaveLength(1);
  });
});

describe('the category list', () => {
  test('the categories collection is read into the list', async () => {
    const { categories } = await lookups({
      categories: [{ _id: 'cat-1', categoryId: 'SUV', category: 'SUV', title: 'Sport Utility' }],
    });

    expect(categories.map((c) => c.code)).toContain('SUV');
  });

  test('a category seen only on a fleet row is added too', async () => {
    const { categories } = await lookups({ fleetRows: [fleet({ categoryCode: 'LUX' })] });

    expect(categories.map((c) => c.code)).toContain('LUX');
  });

  test('the list is sorted by code', async () => {
    const { categories } = await lookups({
      fleetRows: [
        fleet({ _id: 'f-1', categoryCode: 'SUV' }),
        fleet({ _id: 'f-2', categoryCode: 'ECO' }),
        fleet({ _id: 'f-3', categoryCode: 'LUX' }),
      ],
    });

    const codes = categories.map((c) => c.code);
    expect(codes).toEqual([...codes].sort());
  });

  test('an unreadable categories collection leaves the fleet-derived ones intact', async () => {
    install();
    const original = wixData.query;
    wixData.query = (collection) => {
      if (collection === 'VehiclesNew') throw new Error('collection missing');
      return original.call(wixData, collection);
    };
    let res;
    try {
      res = await getContract({ authToken: await token(), bookingId: BOOKING_ID });
    } finally {
      wixData.query = original;
    }

    expect(res.success).toBe(true);
    expect(res.lookups.categories.map((c) => c.code)).toContain('ECO');
  });
});

describe('the customer directory', () => {
  const customer = (extra = {}) => ({
    _id: 'cu-1', isActive: true, fullName: 'A Customer', email: 'a@example.com',
    mobilePhone: '2101234567', ...extra,
  });

  test('an active customer is offered with the fields the form fills from', async () => {
    const { customers } = await lookups({
      customers: [customer({
        address: '12 Tsimiski', city: 'Thessaloniki', idNumber: 'ID-1',
        licenseNumber: 'DL-1', licenseCountry: 'GR', customerCode: 'C-001',
      })],
    });

    expect(customers[0]).toMatchObject({
      customerId: 'cu-1', customerCode: 'C-001', name: 'A Customer',
      email: 'a@example.com', phone: '2101234567',
      address: '12 Tsimiski', residenceCity: 'Thessaloniki', originCity: 'Thessaloniki',
      idNo: 'ID-1', licenseNo: 'DL-1', licenseCountry: 'GR',
    });
  });

  test('an inactive customer is not offered', async () => {
    const { customers } = await lookups({ customers: [customer({ isActive: false })] });

    expect(customers).toEqual([]);
  });

  test('a name is assembled from the parts when there is no full name', async () => {
    const { customers } = await lookups({
      customers: [customer({ fullName: '', firstName: 'A', lastName: 'Customer' })],
    });

    expect(customers[0].name).toBe('A Customer');
  });

  test('a row with nothing to identify it is skipped', async () => {
    // No name, no email, no phone, no document: there would be nothing for the
    // operator to search on and nothing to fill in.
    const { customers } = await lookups({
      customers: [customer({ fullName: '', email: '', mobilePhone: '', notes: 'just a note' })],
    });

    expect(customers).toEqual([]);
  });

  test('a row identified only by a document is kept', async () => {
    const { customers } = await lookups({
      customers: [customer({ fullName: '', email: '', mobilePhone: '', idNumber: 'ID-9' })],
    });

    expect(customers).toHaveLength(1);
    expect(customers[0].idNo).toBe('ID-9');
  });

  test('a passport stands in for an id number', async () => {
    const { customers } = await lookups({ customers: [customer({ passportNumber: 'P-1' })] });

    expect(customers[0].idNo).toBe('P-1');
  });

  test('dates are reduced to the form values the inputs expect', async () => {
    const { customers } = await lookups({
      customers: [customer({
        licenseExpiry: '2030-06-01T00:00:00.000Z', dateOfBirth: '1990-01-15T00:00:00.000Z',
      })],
    });

    expect(customers[0].licenseExpiry).toBe('2030-06-01');
    expect(customers[0].dob).toBe('1990-01-15');
  });

  test('the search blob is lower-cased for matching', async () => {
    const { customers } = await lookups({ customers: [customer({ searchBlob: 'A CUSTOMER Thessaloniki' })] });

    expect(customers[0].searchBlob).toBe('a customer thessaloniki');
  });

  test('an unreadable customers collection leaves the rest of the lookups usable', async () => {
    install({ customers: [customer()] });
    const original = wixData.query;
    wixData.query = (collection) => {
      if (collection === 'Customers') throw new Error('collection missing');
      return original.call(wixData, collection);
    };
    let res;
    try {
      res = await getContract({ authToken: await token(), bookingId: BOOKING_ID });
    } finally {
      wixData.query = original;
    }

    expect(res.success).toBe(true);
    expect(res.lookups.customers).toEqual([]);
    expect(res.lookups.vehicles.length).toBeGreaterThan(0);
  });
});

describe('the company directory', () => {
  const company = (extra = {}) => ({
    _id: 'co-1', isActive: true, companyName: 'A Company Ltd', vatNumber: 'EL123456789',
    email: 'billing@example.com', ...extra,
  });

  test('an active company is offered with its billing fields', async () => {
    const { companies } = await lookups({
      companies: [company({
        taxOffice: 'A Tax Office', address: '1 Main St', city: 'Athens',
        zipCode: '10000', country: 'GR', contactPerson: 'A Contact', poNumberDefault: 'PO-1',
      })],
    });

    expect(companies[0]).toMatchObject({
      companyId: 'co-1', companyName: 'A Company Ltd', vatNumber: 'EL123456789',
      taxOffice: 'A Tax Office', address: '1 Main St', city: 'Athens',
      zip: '10000', country: 'GR', contactPerson: 'A Contact', poNumberDefault: 'PO-1',
    });
  });

  test('an inactive company is not offered', async () => {
    const { companies } = await lookups({ companies: [company({ isActive: false })] });

    expect(companies).toEqual([]);
  });

  test('a row with nothing to identify it is skipped', async () => {
    const { companies } = await lookups({
      companies: [company({ companyName: '', vatNumber: '', email: '', phone: '' })],
    });

    expect(companies).toEqual([]);
  });

  test('a row identified only by a VAT number is kept', async () => {
    const { companies } = await lookups({
      companies: [company({ companyName: '', email: '' })],
    });

    expect(companies).toHaveLength(1);
  });

  test('the title stands in for a missing company name', async () => {
    const { companies } = await lookups({ companies: [company({ companyName: '', title: 'A Company Ltd' })] });

    expect(companies[0].companyName).toBe('A Company Ltd');
  });

  test('an unreadable companies collection leaves the rest of the lookups usable', async () => {
    install({ companies: [company()] });
    const original = wixData.query;
    wixData.query = (collection) => {
      if (collection === 'Companies') throw new Error('collection missing');
      return original.call(wixData, collection);
    };
    let res;
    try {
      res = await getContract({ authToken: await token(), bookingId: BOOKING_ID });
    } finally {
      wixData.query = original;
    }

    expect(res.success).toBe(true);
    expect(res.lookups.companies).toEqual([]);
    expect(res.lookups.customers).toEqual([]);
  });
});
