import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import { getDailyOps } from '../dailyOps.jsw';
import { asId, refId, catCode, fleetCatCode, isOpaqueCategoryId, getFleetCalendarData } from '../fleetCalendar.jsw';

// Two things here, both about reading fields whose shape the CMS does not
// guarantee.
//
// Wix stores a date as a Date, but an imported or API-written row can hold an
// object wrapper instead — { value }, { $date }, { iso }. dailyOps unwraps those
// before deciding which day a booking belongs to, and a booking whose date it
// cannot read simply vanishes from the board.
//
// The fleet calendar has the same problem with references: a category can arrive
// as a string, as an included object, or as an array of one.

const PASSWORD = 'correct-horse-battery';
const ADMIN = 'admin@example.com';
const DATE = '2026-03-10';

function seed({ bookings = [], fleetRows = [] } = {}) {
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
    BookingsNew: bookings,
    RentalsNew: [],
    FleetNew: fleetRows,
    VehiclesNew: [],
  };
}

let fake;
const install = (options) => { fake = createFakeWixData(seed(options)).install(wixData); return fake; };
const token = async () => (await loginStaff({ email: ADMIN, password: PASSWORD })).sessionToken;
const day = async () => getDailyOps({
  authToken: await token(),
  startISO: `${DATE}T00:00:00.000Z`,
  endISO: `${DATE}T23:59:59.999Z`,
});

const confirmed = (extra = {}) => ({
  _id: 'b-1', bookingNumber: 'BK-1', status: 'Confirmed', rentalState: 'Booking',
  customerName: 'A Guest',
  pickupDateTime: `${DATE}T09:00:00.000Z`,
  dropoffDateTime: `${DATE}T18:00:00.000Z`,
  ...extra,
});

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('reading a date that arrived wrapped in an object', () => {
  test.each([
    ['value', { value: `${DATE}T09:00:00.000Z` }],
    ['date', { date: `${DATE}T09:00:00.000Z` }],
    ['$date', { $date: `${DATE}T09:00:00.000Z` }],
    ['iso', { iso: `${DATE}T09:00:00.000Z` }],
    ['_date', { _date: `${DATE}T09:00:00.000Z` }],
  ])('a pickup wrapped as { %s } still lands on the right day', async (_label, pickupDateTime) => {
    install({ bookings: [confirmed({ pickupDateTime })] });

    const res = await day();

    expect(res.checkOut.map((b) => b.bookingNumber)).toEqual(['BK-1']);
  });

  test('a wrapper holding nothing usable leaves the booking off the board', async () => {
    // Not an error, and not a booking filed under today by accident: a row whose
    // date cannot be read is one the board cannot place.
    install({ bookings: [confirmed({ pickupDateTime: { value: 'not a date' } })] });

    const res = await day();

    expect(res.checkOut).toEqual([]);
  });

  test('a real Date is read directly rather than unwrapped', async () => {
    install({ bookings: [confirmed({ pickupDateTime: new Date(`${DATE}T09:00:00.000Z`) })] });

    expect((await day()).checkOut.map((b) => b.bookingNumber)).toEqual(['BK-1']);
  });

  test('the confirmation time is read through the same wrappers', async () => {
    install({ bookings: [confirmed({ confirmedAt: { $date: `${DATE}T08:00:00.000Z` } })] });

    expect((await day()).bookings.map((b) => b.bookingNumber)).toEqual(['BK-1']);
  });

  test('the confirmation time falls back through its alternative spellings', async () => {
    install({ bookings: [confirmed({ Confirmedat: `${DATE}T08:00:00.000Z` })] });

    expect((await day()).bookings.map((b) => b.bookingNumber)).toEqual(['BK-1']);
  });

  test('a status change stands in when there is no confirmation time', async () => {
    install({ bookings: [confirmed({ statusChangedAt: `${DATE}T08:00:00.000Z` })] });

    expect((await day()).bookings.map((b) => b.bookingNumber)).toEqual(['BK-1']);
  });

  test('the cancellation time is read through the wrappers too', async () => {
    install({
      bookings: [confirmed({ status: 'Canceled', canceledAt: { iso: `${DATE}T12:00:00.000Z` } })],
    });

    expect((await day()).tabs.cancellations.map((b) => b.bookingNumber)).toEqual(['BK-1']);
  });
});

describe('the daily board when the read fails outright', () => {
  test('an unreadable bookings collection is reported rather than thrown', async () => {
    install({ bookings: [confirmed()] });
    const authToken = await token();
    const original = wixData.query;
    wixData.query = (name) => {
      if (String(name).startsWith('Staff')) return original.call(wixData, name);
      throw new Error('collection missing');
    };
    try {
      const res = await getDailyOps({
        authToken, startISO: `${DATE}T00:00:00.000Z`, endISO: `${DATE}T23:59:59.999Z`,
      });

      expect(res).toMatchObject({ success: false, message: 'collection missing' });
    } finally {
      wixData.query = original;
    }
  });

  test('a range that runs backwards is refused before any read', async () => {
    install({ bookings: [confirmed()] });

    const res = await getDailyOps({
      authToken: await token(),
      startISO: `${DATE}T23:00:00.000Z`,
      endISO: `${DATE}T01:00:00.000Z`,
    });

    expect(res).toMatchObject({ success: false, message: 'Invalid range' });
  });
});

describe('reading an id off a Wix reference', () => {
  test('a plain string is its own id', () => {
    expect(asId('f-1')).toBe('f-1');
  });

  test.each([
    ['_id', { _id: 'f-1' }],
    ['id', { id: 'f-1' }],
    ['_ref', { _ref: 'f-1' }],
    ['value', { value: 'f-1' }],
  ])('an included object exposing %s is unwrapped', (_label, value) => {
    expect(asId(value)).toBe('f-1');
  });

  test('an object with none of those keys yields an empty id, not "undefined"', () => {
    expect(asId({ label: 'Fiat Panda' })).toBe('');
  });

  test('a number is stringified rather than dropped', () => {
    expect(asId(42)).toBe('42');
  });

  test.each([null, undefined, '', 0, false])('%p has no id', (value) => {
    expect(asId(value)).toBe('');
  });

  test.each(['unassigned', 'UNASSIGNED', 'null', 'undefined', ' Null '])(
    'the placeholder %p is treated as no reference at all',
    (value) => {
      // These arrive from a cleared dropdown. Left as-is they would be looked up
      // as a vehicle id and match nothing, which reads the same as a genuine
      // assignment that has gone missing.
      expect(refId(value)).toBe('');
    },
  );

  test('a real id survives the placeholder check', () => {
    expect(refId('f-1')).toBe('f-1');
    expect(refId({ _id: 'f-1' })).toBe('f-1');
  });
});

describe('reading a category code off whatever shape it arrives in', () => {
  test('a plain code is upper-cased', () => {
    expect(catCode('eco')).toBe('ECO');
  });

  test.each([
    ['category', { category: 'ECO' }],
    ['code', { code: 'ECO' }],
    ['cat', { cat: 'ECO' }],
    ['title', { title: 'ECO' }],
    ['name', { name: 'ECO' }],
    ['label', { label: 'ECO' }],
    ['value', { value: 'ECO' }],
  ])('an included object exposing %s is unwrapped', (_label, value) => {
    expect(catCode(value)).toBe('ECO');
  });

  test('an array of one is unwrapped', () => {
    expect(catCode(['ECO'])).toBe('ECO');
  });

  test('a label carrying the code takes only the first token', () => {
    expect(catCode('ECO - Fiat Panda')).toBe('ECO');
    expect(catCode('A/Hyundai i10')).toBe('A');
  });

  test('a Greek chi is folded to a Latin X', () => {
    // The two characters are indistinguishable on screen and a category typed
    // with one would never match a fleet row stamped with the other.
    expect(catCode('Χ')).toBe('X');
  });

  test('an opaque record id is not mistaken for a category code', () => {
    expect(catCode('8f14e45f-ceea-4e78-9c8f-1a2b3c4d5e6f')).toBe('');
    expect(catCode({ _id: '8f14e45fceea4e789c8f' })).toBe('');
  });

  test.each([null, undefined, '', {}])('%p yields no code', (value) => {
    expect(catCode(value)).toBe('');
  });

  test('a fleet row with no readable category is filed under "Other"', () => {
    expect(fleetCatCode({})).toBe('Other');
    expect(fleetCatCode(null)).toBe('Other');
  });

  test.each([
    ['a uuid', '8f14e45f-ceea-4e78-9c8f-1a2b3c4d5e6f', true],
    ['a long opaque token', 'abc123def456', true],
    ['a short code', 'ECO', false],
    ['a single letter', 'A', false],
    ['an empty string', '', false],
  ])('%s is%s an opaque id', (_label, value, expected) => {
    expect(isOpaqueCategoryId(value)).toBe(expected);
  });
});

describe('the fleet calendar when its field mapping cannot be read', () => {
  test('an unreadable bookings collection leaves the calendar on its default field names', async () => {
    // The mapper samples a row to learn which spelling of each field this site
    // uses. With nothing to sample it keeps the defaults, which is what a fresh
    // site has anyway — so the calendar still renders rather than failing.
    install({ bookings: [], fleetRows: [] });

    const res = await getFleetCalendarData({ authToken: await token(), from: DATE, to: '2026-03-24' });

    expect(res).toMatchObject({
      groups: expect.any(Array), items: expect.any(Array), unassigned: expect.any(Array),
    });
  });

  test('a calendar with vehicles and bookings still builds when a category arrives as an object', async () => {
    install({
      bookings: [confirmed({ assignedVehicle: 'f-1' })],
      fleetRows: [{
        _id: 'f-1', plate: 'AAA-1', model: 'Fiat Panda',
        category: { title: 'ECO - Economy' }, active: true,
      }],
    });

    const res = await getFleetCalendarData({ authToken: await token(), from: DATE, to: '2026-03-24' });

    expect(res.groups.length).toBeGreaterThan(0);
    expect(res.items.length).toBeGreaterThan(0);
  });
});
