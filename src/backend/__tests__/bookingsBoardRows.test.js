import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import { confirmAndAutoAssign } from 'backend/fleetCalendar';
import { getBookingsBoardData, setBookingBoardStatus } from '../bookingsBoard.jsw';

// What each row on the bookings board says, field by field.
//
// bookingsBoard covers the date range, the row flags, the permission split and
// the status write. This covers the mapping underneath: the fallback chains that
// decide what a branch actually reads off the screen when a booking arrived from
// an importer, a partner channel or a walk-in and does not carry the fields the
// site's own form would have set.
//
// That was the module's branch gap — 99% statements against 70% branches,
// because a fallback chain is one statement and several decisions.

jest.mock('backend/fleetCalendar', () => ({
  confirmAndAutoAssign: jest.fn(async () => ({ success: true, assigned: true })),
}));

const ADMIN = 'admin@example.com';
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
    StaffRoles: [{ _id: 'role-admin', key: 'admin', label: 'Administrator', active: true }],
    StaffUsers: [{ _id: 'user-admin', email: ADMIN, fullName: 'Admin', roleKey: 'admin', active: true }],
    StaffCredentials: [credential(ADMIN)],
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
/** The single booking's row, with the given fields varied. */
async function row(over) {
  install(seed({ BookingsNew: [booking(over)] }));
  const res = await getBookingsBoardData({ authToken: await token() });
  expect(res.success).toBe(true);
  return res.items[0];
}
/** The single booking's row, with a fleet record behind it. */
async function rowWithFleet(fleetRow, bookingOver = {}) {
  install(seed({
    BookingsNew: [booking({ assignedVehicle: 'car-1', ...bookingOver })],
    FleetNew: [fleetRow],
  }));
  const res = await getBookingsBoardData({ authToken: await token() });
  expect(res.success).toBe(true);
  return res.items[0];
}

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

describe('reading the fleet record behind a row', () => {
  test('plate and model read either capitalisation', async () => {
    const r = await rowWithFleet({ _id: 'car-1', Plate: 'AAA-1111', Model: 'Aygo' });
    expect(r.assignedVehiclePlate).toBe('AAA-1111');
    expect(r.assignedVehicleModel).toBe('Aygo');
  });

  test('the model falls back to the title, in either capitalisation', async () => {
    expect((await rowWithFleet({ _id: 'car-1', plate: 'AAA-1111', title: 'Aygo' })).assignedVehicleModel).toBe('Aygo');
    expect((await rowWithFleet({ _id: 'car-1', plate: 'AAA-1111', Title: 'Aygo' })).assignedVehicleModel).toBe('Aygo');
  });

  test('the label joins plate and model', async () => {
    expect((await rowWithFleet({ _id: 'car-1', plate: 'AAA-1111', model: 'Aygo' })).assignedVehicleLabel)
      .toBe('AAA-1111 - Aygo');
  });

  test('the label is the plate alone when there is no model', async () => {
    expect((await rowWithFleet({ _id: 'car-1', plate: 'AAA-1111' })).assignedVehicleLabel).toBe('AAA-1111');
  });

  test('a fleet record with neither leaves the label empty rather than showing a dash', async () => {
    expect((await rowWithFleet({ _id: 'car-1' })).assignedVehicleLabel).toBe('');
  });

  test('the category code reads four spellings on the fleet record', async () => {
    for (const field of ['category', 'Category', 'categoryCode', 'categorycode']) {
      const r = await rowWithFleet({ _id: 'car-1', plate: 'AAA-1111', [field]: 'ECO' });
      expect(r.assignedCategoryCode).toBe('ECO');
    }
  });

  test('a category held as a reference object is unwrapped', async () => {
    for (const key of ['category', 'code', 'title', 'name']) {
      const r = await rowWithFleet({ _id: 'car-1', plate: 'AAA-1111', category: { [key]: 'ECO' } });
      expect(r.assignedCategoryCode).toBe('ECO');
    }
  });

  test('a category object with none of those keys yields no code', async () => {
    const r = await rowWithFleet({ _id: 'car-1', plate: 'AAA-1111', category: { somethingElse: 'ECO' } });
    expect(r.assignedCategoryCode).toBe('');
  });

  test('a descriptive category label is reduced to its code', async () => {
    const r = await rowWithFleet({ _id: 'car-1', plate: 'AAA-1111', category: 'ECO - Economy' });
    expect(r.assignedCategoryCode).toBe('ECO');
  });

  test('no fleet lookup is attempted when nothing is assigned', async () => {
    // getFleetMap returns early on an empty id list, so a board with no
    // assignments does not query the fleet at all.
    install(seed({ BookingsNew: [booking()], FleetNew: [{ _id: 'car-1', plate: 'AAA-1111' }] }));
    const collections = [];
    const original = wixData.query;
    wixData.query = (collection) => { collections.push(collection); return original(collection); };
    try {
      await getBookingsBoardData({ authToken: await token() });
      expect(collections).not.toContain('FleetNew');
    } finally {
      wixData.query = original;
    }
  });

  test('two bookings on the same vehicle ask for that id once', async () => {
    // Asserted on the argument, not the query count — there is one query either
    // way. A board of a thousand bookings on a small fleet must not send the
    // same id a thousand times.
    //
    // Note it is de-duplicated twice: getBookingsBoardData builds a Set before
    // calling getFleetMap, which makes its own. Removing either one alone
    // changes nothing observable here; the caller's is the one that does the
    // work on this path.
    install(seed({
      BookingsNew: [
        booking({ _id: 'bk-1', assignedVehicle: 'car-1' }),
        booking({ _id: 'bk-2', assignedVehicle: 'car-1' }),
      ],
      FleetNew: [{ _id: 'car-1', plate: 'AAA-1111', model: 'Aygo' }],
    }));
    const hasSomeArgs = [];
    const original = wixData.query;
    wixData.query = (collection) => {
      const builder = original(collection);
      if (collection !== 'FleetNew') return builder;
      const realHasSome = builder.hasSome.bind(builder);
      builder.hasSome = (field, values) => { hasSomeArgs.push(values); return realHasSome(field, values); };
      return builder;
    };
    try {
      const res = await getBookingsBoardData({ authToken: await token() });
      expect(hasSomeArgs).toEqual([['car-1']]);
      expect(res.items.every((r) => r.assignedVehicleLabel === 'AAA-1111 - Aygo')).toBe(true);
    } finally {
      wixData.query = original;
    }
  });

  test('a fleet record with only a model is labelled by it — via the row, not the map', async () => {
    // The map's own `: model` branch is masked here: mapBooking's label chain
    // ends in assignedVehicleModel, which is itself read off the fleet record.
    // So the answer is the same whichever of the two supplies it. Recorded so
    // the redundancy is not mistaken for a gap.
    const r = await rowWithFleet({ _id: 'car-1', model: 'Aygo' });
    expect(r.assignedVehicleLabel).toBe('Aygo');
    expect(r.assignedVehicleModel).toBe('Aygo');
  });
});

describe('what a row falls back to', () => {
  test('a booking with no status reads as Pending', async () => {
    expect((await row({ status: '' })).status).toBe('Pending');
    expect((await row({ status: undefined })).status).toBe('Pending');
  });

  test('a booking with no number is identified by its record id', async () => {
    expect((await row({ bookingNumber: '' }))?.bookingNumber).toBe('bk-1');
  });

  test('a booking with no customer name shows a dash', async () => {
    expect((await row({ customerName: '' })).customerName).toBe('-');
  });

  test('the phone and email fall back to the main driver', async () => {
    const r = await row({ phone: '', email: '', mainDriver: { phone: '+30 111', email: 'driver@example.com' } });
    expect(r.phone).toBe('+30 111');
    expect(r.email).toBe('driver@example.com');
  });

  test('the booking\'s own contact details win over the driver\'s', async () => {
    const r = await row({ phone: '+30 999', email: 'booking@example.com', mainDriver: { phone: '+30 111', email: 'driver@example.com' } });
    expect(r.phone).toBe('+30 999');
    expect(r.email).toBe('booking@example.com');
  });

  test('a booking with no main driver at all does not fail', async () => {
    const r = await row({ phone: '', email: '' });
    expect(r.phone).toBe('');
    expect(r.email).toBe('');
  });

  test('an absent dropoff date comes back as null, not undefined', async () => {
    // Seeded absent rather than as null: with the field present-but-null the
    // mapper's `|| null` and a bare passthrough give the same answer, so only an
    // absent field can tell them apart. The board serialises these rows to the
    // page, where undefined would vanish from the payload entirely.
    const base = booking();
    delete base.dropoffDateTime;
    install(seed({ BookingsNew: [base] }));
    const res = await getBookingsBoardData({ authToken: await token() });
    const r = res.items[0];

    expect(r.dropoffDateTime).toBeNull();
    expect('dropoffDateTime' in r).toBe(true);
    expect(r.overdue).toBe(false);
  });

  test('a row label falls back to the plate when there is no fleet record', async () => {
    // The plate link in mapBooking's label chain only carries the answer when
    // the fleet lookup found nothing — otherwise fleet.label is already the
    // plate and masks it.
    install(seed({ BookingsNew: [booking({ assignedVehicle: 'car-gone', assignedVehiclePlate: 'AAA-1111' })] }));
    const res = await getBookingsBoardData({ authToken: await token() });
    expect(res.items[0].assignedVehicleLabel).toBe('AAA-1111');
  });

  test('and to the model when not even a plate is known', async () => {
    install(seed({ BookingsNew: [booking({ assignedVehicle: 'car-gone', assignedVehicleModel: 'Aygo' })] }));
    const res = await getBookingsBoardData({ authToken: await token() });
    expect(res.items[0].assignedVehicleLabel).toBe('Aygo');
  });

  test('a booking with an unparseable pickup date never reaches the board', async () => {
    // The range filter is applied in the query, so such a booking is excluded
    // before the row mapper sees it. That makes the mapper's own pickupTs = 0
    // fallback unreachable through this endpoint — worth stating, because the
    // fallback reads like the safety net and the query is what actually is one.
    install(seed({ BookingsNew: [booking({ pickupDateTime: 'sometime' })] }));
    const res = await getBookingsBoardData({ authToken: await token() });
    expect(res.success).toBe(true);
    expect(res.items).toEqual([]);
  });

  test('the origin city falls through three fields', async () => {
    expect((await row({ originCity: 'Athens', city: 'X', customerCity: 'Y' })).originCity).toBe('Athens');
    expect((await row({ city: 'Patras', customerCity: 'Y' })).originCity).toBe('Patras');
    expect((await row({ customerCity: 'Volos' })).originCity).toBe('Volos');
    expect((await row({})).originCity).toBe('');
  });

  test('the voucher number falls through four fields', async () => {
    expect((await row({ voucherNumber: 'V1' })).voucherNumber).toBe('V1');
    expect((await row({ voucher: 'V2' })).voucherNumber).toBe('V2');
    expect((await row({ voucherNo: 'V3' })).voucherNumber).toBe('V3');
    expect((await row({ voucherId: 'V4' })).voucherNumber).toBe('V4');
    expect((await row({})).voucherNumber).toBe('');
  });

  test('the confirmation number falls through four fields', async () => {
    expect((await row({ confirmationNumber: 'C1' })).confirmationNumber).toBe('C1');
    expect((await row({ confirmation: 'C2' })).confirmationNumber).toBe('C2');
    expect((await row({ confirmationNo: 'C3' })).confirmationNumber).toBe('C3');
    expect((await row({ confirmationId: 'C4' })).confirmationNumber).toBe('C4');
    expect((await row({})).confirmationNumber).toBe('');
  });

  test('extras that are not a list become an empty one', async () => {
    expect((await row({ selectedExtras: ['gps'] })).selectedExtras).toEqual(['gps']);
    expect((await row({ selectedExtras: 'gps,seat' })).selectedExtras).toEqual([]);
    expect((await row({})).selectedExtras).toEqual([]);
  });

  test('the created date falls through to the update date, then to now', async () => {
    expect((await row({ _createdDate: '2026-01-01T00:00:00.000Z' })).createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect((await row({ createdAtApp: '2026-01-02T00:00:00.000Z' })).createdAt).toBe('2026-01-02T00:00:00.000Z');
    expect((await row({ _updatedDate: '2026-01-03T00:00:00.000Z' })).createdAt).toBe('2026-01-03T00:00:00.000Z');
    expect(new Date((await row({})).createdAt).toISOString()).toBe(NOW);
  });

  test('the category shows a dash when nothing identifies it', async () => {
    expect((await row({})).category).toBe('-');
  });

  test('numbers that are absent read as zero, not as blank', async () => {
    const r = await row({ totalPrice: undefined, basePricePerDay: undefined, insuranceExtraPerDay: undefined, extrasTotal: undefined, triageScore: undefined });
    expect(r).toMatchObject({ totalPrice: 0, basePricePerDay: 0, insuranceExtraPerDay: 0, extrasTotal: 0, triageScore: 0 });
  });

  test('the triage fields come back blank rather than undefined', async () => {
    const r = await row({});
    expect(r.triageOwner).toBe('');
    expect(r.triageLastAction).toBe('');
    expect(r.triageNextFollowUpAt).toBeNull();
  });
});

describe('when the board itself fails', () => {
  test('a broken bookings collection reports the failure with an empty list', async () => {
    // The handler catches everything, so without the message a crash would be
    // indistinguishable from a quiet week.
    install();
    const t = await token();
    const original = wixData.query;
    // Scoped to the one collection: breaking every query breaks the session
    // lookup too, and the call would then fail at the auth gate instead of in
    // the handler's own catch.
    wixData.query = (collection) => {
      if (collection === 'BookingsNew') throw new Error('BookingsNew is offline');
      return original(collection);
    };
    try {
      await expect(getBookingsBoardData({ authToken: t }))
        .resolves.toEqual({ success: false, message: 'BookingsNew is offline', items: [] });
    } finally {
      wixData.query = original;
    }
  });

  test('a broken fleet collection fails the board rather than blanking the vehicles', async () => {
    // Worth knowing: getFleetMap has no catch of its own, so a fleet outage
    // takes the whole board down instead of degrading to unlabelled rows.
    install(seed({
      BookingsNew: [booking({ assignedVehicle: 'car-1' })],
      FleetNew: [{ _id: 'car-1', plate: 'AAA-1111' }],
    }));
    const t = await token();
    const original = wixData.query;
    wixData.query = (collection) => {
      if (collection === 'FleetNew') throw new Error('FleetNew is offline');
      return original(collection);
    };
    try {
      const res = await getBookingsBoardData({ authToken: t });
      expect(res).toMatchObject({ success: false, message: 'FleetNew is offline', items: [] });
    } finally {
      wixData.query = original;
    }
  });

  test('the failure is reported after the auth gate, not instead of it', async () => {
    install();
    const original = wixData.query;
    wixData.query = (collection) => {
      if (collection === 'BookingsNew') throw new Error('offline');
      return original(collection);
    };
    try {
      await expect(getBookingsBoardData({})).rejects.toThrow('AUTH_REQUIRED');
    } finally {
      wixData.query = original;
    }
  });
});

describe('when a status change fails', () => {
  test('a failed auto-assignment reports the reason it gave', async () => {
    install();
    confirmAndAutoAssign.mockResolvedValue({ success: false, message: 'No vehicle free' });
    await expect(setBookingBoardStatus({ authToken: await token(), bookingId: 'bk-1', newStatus: 'Confirmed' }))
      .resolves.toEqual({ success: false, message: 'No vehicle free' });
  });

  test('and falls back to a generic message when it gave none', async () => {
    install();
    confirmAndAutoAssign.mockResolvedValue({ success: false });
    await expect(setBookingBoardStatus({ authToken: await token(), bookingId: 'bk-1', newStatus: 'Confirmed' }))
      .resolves.toEqual({ success: false, message: 'Confirm failed' });
  });

  test('an auto-assignment that answers nothing at all is treated as a failure', async () => {
    install();
    confirmAndAutoAssign.mockResolvedValue(undefined);
    await expect(setBookingBoardStatus({ authToken: await token(), bookingId: 'bk-1', newStatus: 'Confirmed' }))
      .resolves.toEqual({ success: false, message: 'Confirm failed' });
  });

  test('an unknown booking is reported rather than thrown', async () => {
    install();
    const res = await setBookingBoardStatus({ authToken: await token(), bookingId: 'no-such', newStatus: 'Hold' });
    expect(res.success).toBe(false);
    expect(res.message).toBeTruthy();
  });

  test('a write failure is reported as a message', async () => {
    install();
    const t = await token();
    wixData.update = () => Promise.reject(new Error('collection is offline'));
    await expect(setBookingBoardStatus({ authToken: t, bookingId: 'bk-1', newStatus: 'Hold' }))
      .resolves.toEqual({ success: false, message: 'collection is offline' });
  });

  test('a status outside the allowed set is refused before anything is read', async () => {
    install();
    const res = await setBookingBoardStatus({ authToken: await token(), bookingId: 'bk-1', newStatus: 'Deleted' });
    expect(res).toEqual({ success: false, message: 'Invalid status' });
    expect(fake.calls.update.filter((c) => c.collection === 'BookingsNew')).toHaveLength(0);
  });

  test('every allowed status is accepted', async () => {
    for (const status of ['Pending', 'Hold', 'Escalated']) {
      install();
      const res = await setBookingBoardStatus({ authToken: await token(), bookingId: 'bk-1', newStatus: status });
      expect(res).toMatchObject({ success: true, message: `Booking ${status.toLowerCase()}` });
      fake.restore();
      fake = null;
    }
  });
});
