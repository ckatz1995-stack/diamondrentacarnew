import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import { getDailyOps, actOnDailyRequest } from '../dailyOps.jsw';

// The daily operations board: one query over every booking, sorted into the
// buckets a branch works through in a day — who is picking up, who is dropping
// off, who is overdue, which cars are free. Two things make it worth pinning.
//
// First, every booking is classified by *derived* predicates rather than by a
// stored field, so a booking can silently land in the wrong bucket (or none) and
// the only symptom is a row missing from a screen — nothing throws.
//
// Second, getDailyOps wraps its whole body in a try/catch that returns
// `{ success: false, message }`. Any error inside becomes a soft failure that
// looks like an empty board, so every test here asserts `success === true`
// before looking at the contents. Without that a broken bucket and a crash are
// indistinguishable.

const ADMIN = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';

// A one-day window. Bucket membership is half-open — `dt >= start && dt < end` —
// so the boundaries are load-bearing and tested directly below.
const START = '2026-03-10T00:00:00.000Z';
const END = '2026-03-11T00:00:00.000Z';

function credential(email, password = PASSWORD) {
  const passwordSalt = randomHex(16);
  return {
    _id: `cred-${email}`,
    email,
    passwordSalt,
    passwordHash: derivePasswordHash(password, passwordSalt),
    active: true,
  };
}

function booking(over = {}) {
  return {
    status: 'Confirmed',
    rentalState: 'Booking',
    customerName: 'A Customer',
    assignedVehicle: '',
    ...over,
  };
}

function seed(extra = {}) {
  return {
    StaffRoles: [
      { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true },
    ],
    StaffUsers: [
      { _id: 'user-admin', email: ADMIN, fullName: 'Admin User', roleKey: 'admin', active: true },
    ],
    StaffCredentials: [credential(ADMIN)],
    StaffSessions: [],
    StaffAuditLog: [],
    BookingsNew: [
      // Picks up inside the window.
      booking({
        _id: 'b-checkout',
        bookingNumber: 'RNT-0001',
        pickupDateTime: '2026-03-10T09:00:00.000Z',
        dropoffDateTime: '2026-03-14T09:00:00.000Z',
        assignedVehicle: 'car-1',
      }),
      // Drops off inside the window, picked up before it.
      booking({
        _id: 'b-checkin',
        bookingNumber: 'RNT-0002',
        pickupDateTime: '2026-03-05T09:00:00.000Z',
        dropoffDateTime: '2026-03-10T11:00:00.000Z',
      }),
      // Should have come back two days ago and has not been closed.
      booking({
        _id: 'b-overdue',
        bookingNumber: 'RNT-0003',
        rentalState: 'Active Rental',
        pickupDateTime: '2026-03-01T09:00:00.000Z',
        dropoffDateTime: '2026-03-08T10:00:00.000Z',
      }),
      // On the road across the window — its vehicle is spoken for.
      booking({
        _id: 'b-active',
        bookingNumber: 'RNT-0004',
        rentalState: 'Active Rental',
        pickupDateTime: '2026-03-09T08:00:00.000Z',
        dropoffDateTime: '2026-03-12T08:00:00.000Z',
        assignedVehicle: 'car-2',
      }),
      // Unconfirmed, wants a car later today.
      booking({
        _id: 'b-request',
        bookingNumber: 'RNT-0005',
        status: 'Pending',
        pickupDateTime: '2026-03-10T18:00:00.000Z',
        dropoffDateTime: '2026-03-13T18:00:00.000Z',
      }),
      // Called off this morning.
      booking({
        _id: 'b-canceled',
        bookingNumber: 'RNT-0006',
        status: 'Canceled',
        canceledAt: '2026-03-10T06:00:00.000Z',
        pickupDateTime: '2026-03-20T09:00:00.000Z',
        dropoffDateTime: '2026-03-22T09:00:00.000Z',
      }),
    ],
    FleetNew: [
      { _id: 'car-1', plate: 'AAA-1111', model: 'Aygo', category: 'ECO - Economy', operationalStatus: 'Ready', readyToGo: true },
      { _id: 'car-2', plate: 'BBB-2222', model: 'Yaris', operationalStatus: 'Ready', readyToGo: true },
      { _id: 'car-3', plate: 'CCC-3333', model: 'Polo', state: 'Maintenance' },
    ],
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
  const result = await getDailyOps({ authToken: await token(), startISO: START, endISO: END, ...over });
  // A soft failure here would otherwise read as "every bucket is empty".
  expect(result.success).toBe(true);
  return result;
}
const ids = (rows) => (rows || []).map((r) => r._id);
const bookingRow = (id) => fake.rows('BookingsNew').find((b) => b._id === id);

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('auth gating', () => {
  const CALLS = [
    ['getDailyOps', getDailyOps, { startISO: START, endISO: END }],
    ['actOnDailyRequest', actOnDailyRequest, { bookingId: 'b-request', action: 'review' }],
  ];

  test.each(CALLS)('%s refuses a missing token', async (_name, fn, args) => {
    install();
    await expect(fn({ ...args })).rejects.toThrow('AUTH_REQUIRED');
  });

  test.each(CALLS)('%s refuses a bogus token', async (_name, fn, args) => {
    install();
    await expect(fn({ authToken: 'made-up', ...args })).rejects.toThrow('AUTH_REQUIRED');
  });

  test('an unauthenticated call writes nothing', async () => {
    install();
    for (const [, fn, args] of CALLS) {
      await fn({ authToken: 'made-up', ...args }).catch(() => {});
    }
    expect(fake.calls.update).toHaveLength(0);
    expect(fake.calls.insert).toHaveLength(0);
  });
});

describe('range validation', () => {
  test.each([
    ['a missing start', { startISO: '', endISO: END }],
    ['a missing end', { startISO: START, endISO: '' }],
    ['unparseable dates', { startISO: 'not-a-date', endISO: END }],
    ['end before start', { startISO: END, endISO: START }],
    ['a zero-length window', { startISO: START, endISO: START }],
  ])('rejects %s', async (_label, args) => {
    install();
    const result = await getDailyOps({ authToken: await token(), ...args });
    expect(result).toMatchObject({ success: false, message: 'Invalid range' });
  });
});

describe('bucketing', () => {
  test('a booking picking up in the window is a checkout, not a check-in', async () => {
    install();
    const result = await board();
    expect(ids(result.tabs.checkout)).toContain('b-checkout');
    expect(ids(result.tabs.checkin)).not.toContain('b-checkout');
  });

  test('a booking dropping off in the window is a check-in, not a checkout', async () => {
    install();
    const result = await board();
    expect(ids(result.tabs.checkin)).toContain('b-checkin');
    expect(ids(result.tabs.checkout)).not.toContain('b-checkin');
  });

  test('a rental past its dropoff and not closed is overdue', async () => {
    install();
    const result = await board();
    expect(ids(result.tabs.overdue)).toContain('b-overdue');
  });

  test('a closed rental is not overdue however late it was', async () => {
    // The dropoff is still in the past; only rentalState changes. Without this
    // the overdue list would never stop growing.
    install(seed({
      BookingsNew: [booking({
        _id: 'b-overdue',
        rentalState: 'Closed Rental',
        pickupDateTime: '2026-03-01T09:00:00.000Z',
        dropoffDateTime: '2026-03-08T10:00:00.000Z',
      })],
    }));
    const result = await board();
    expect(ids(result.tabs.overdue)).not.toContain('b-overdue');
  });

  test('a canceled booking is never overdue', async () => {
    install(seed({
      BookingsNew: [booking({
        _id: 'b-gone',
        status: 'Canceled',
        pickupDateTime: '2026-03-01T09:00:00.000Z',
        dropoffDateTime: '2026-03-08T10:00:00.000Z',
      })],
    }));
    const result = await board();
    expect(ids(result.tabs.overdue)).not.toContain('b-gone');
  });

  test('an unconfirmed booking is a request, not a checkout', async () => {
    install();
    const result = await board();
    expect(ids(result.tabs.requests)).toContain('b-request');
    expect(ids(result.tabs.checkout)).not.toContain('b-request');
  });

  test('a cancellation is listed by when it was canceled', async () => {
    // Its pickup is ten days out, so it can only be here via canceledAt.
    install();
    const result = await board();
    expect(ids(result.tabs.cancellations)).toContain('b-canceled');
  });

  test('active rentals split at thirty billable days', async () => {
    install(seed({
      BookingsNew: [
        booking({
          _id: 'b-short', rentalState: 'Active Rental',
          pickupDateTime: '2026-03-09T08:00:00.000Z', dropoffDateTime: '2026-03-12T08:00:00.000Z',
        }),
        booking({
          _id: 'b-long', rentalState: 'Active Rental',
          pickupDateTime: '2026-02-01T08:00:00.000Z', dropoffDateTime: '2026-04-30T08:00:00.000Z',
        }),
      ],
    }));
    const result = await board();
    expect(ids(result.tabs.activeUnder)).toEqual(['b-short']);
    expect(ids(result.tabs.activeOver)).toEqual(['b-long']);
  });

  test('the summary counts match the tabs they describe', async () => {
    // The screen renders counts from `summary` and rows from `tabs`; if those
    // are computed from different filters the badge disagrees with the list.
    install();
    const result = await board();
    for (const key of Object.keys(result.summary)) {
      if (!result.tabs[key]) continue;
      expect([key, result.summary[key]]).toEqual([key, result.tabs[key].length]);
    }
  });
});

describe('window boundaries', () => {
  // Half-open: a pickup exactly at `start` belongs to this window, one exactly
  // at `end` belongs to the next. Getting this wrong double-counts a booking on
  // two consecutive days, or drops it from both.
  test.each([
    ['exactly at the start', '2026-03-10T00:00:00.000Z', true],
    ['one millisecond before the start', '2026-03-09T23:59:59.999Z', false],
    ['one millisecond before the end', '2026-03-10T23:59:59.999Z', true],
    ['exactly at the end', '2026-03-11T00:00:00.000Z', false],
  ])('a pickup %s is %s in the checkout list', async (_label, pickup, included) => {
    install(seed({
      BookingsNew: [booking({
        _id: 'b-edge',
        pickupDateTime: pickup,
        dropoffDateTime: '2026-03-20T09:00:00.000Z',
      })],
    }));
    const result = await board();
    expect(ids(result.tabs.checkout).includes('b-edge')).toBe(included);
  });
});

describe('fleet availability', () => {
  test('a vehicle out on an active rental is not offered as available', async () => {
    install();
    const result = await board();
    expect(ids(result.tabs.available)).not.toContain('car-2');
  });

  test('a grounded vehicle is not offered as available', async () => {
    install();
    const result = await board();
    expect(ids(result.tabs.grounded)).toEqual(['car-3']);
    expect(ids(result.tabs.available)).not.toContain('car-3');
  });

  test('a free, roadworthy vehicle is available', async () => {
    install();
    const result = await board();
    expect(ids(result.tabs.available)).toEqual(['car-1']);
  });

  test('available and grounded never overlap', async () => {
    install();
    const result = await board();
    const overlap = ids(result.tabs.available).filter((id) => ids(result.tabs.grounded).includes(id));
    expect(overlap).toEqual([]);
  });

  test.each([
    ['state', 'Maintenance'],
    ['state', 'In repair'],
    ['state', 'Out of service'],
    ['notes', 'grounded pending inspection'],
  ])('a vehicle is grounded by its %s reading "%s"', async (field, value) => {
    install(seed({
      FleetNew: [{ _id: 'car-x', plate: 'XXX-9999', model: 'Ceed', [field]: value }],
      BookingsNew: [],
    }));
    const result = await board();
    expect(ids(result.tabs.grounded)).toEqual(['car-x']);
  });
});

describe('booking rows carry the assigned vehicle', () => {
  test('plate and model are read from the fleet record, not the booking', async () => {
    // The booking stores only the id; the label the board shows has to be
    // resolved, and a stale copy on the booking must not win.
    install(seed({
      BookingsNew: [booking({
        _id: 'b-checkout',
        pickupDateTime: '2026-03-10T09:00:00.000Z',
        dropoffDateTime: '2026-03-14T09:00:00.000Z',
        assignedVehicle: 'car-1',
        assignedVehiclePlate: 'STALE-0000',
        assignedVehicleModel: 'Stale Model',
      })],
    }));
    const result = await board();
    const row = result.tabs.checkout.find((r) => r._id === 'b-checkout');
    expect(row.assignedVehiclePlate).toBe('AAA-1111');
    expect(row.assignedVehicleModel).toBe('Aygo');
  });

  test('a booking with no vehicle is gated out of checkout with a reason', async () => {
    install();
    const result = await board();
    const row = result.tabs.checkin.find((r) => r._id === 'b-checkin');
    expect(row.actionGate.checkoutEligible).toBe(false);
    expect(row.actionGate.reasons).toContain('No assigned vehicle');
  });

  test('a vehicle not marked ready-to-go blocks checkout', async () => {
    install(seed({
      FleetNew: [{ _id: 'car-1', plate: 'AAA-1111', model: 'Aygo', operationalStatus: 'Ready', readyToGo: false }],
    }));
    const result = await board();
    const row = result.tabs.checkout.find((r) => r._id === 'b-checkout');
    expect(row.actionGate.checkoutEligible).toBe(false);
    expect(row.actionGate.reasons).toContain('Vehicle is not ready-to-go');
  });

  test('a service-blocked vehicle blocks checkout', async () => {
    install(seed({
      FleetNew: [{ _id: 'car-1', plate: 'AAA-1111', model: 'Aygo', operationalStatus: 'Blocked', readyToGo: true }],
    }));
    const result = await board();
    const row = result.tabs.checkout.find((r) => r._id === 'b-checkout');
    expect(row.actionGate.checkoutEligible).toBe(false);
    expect(row.actionGate.reasons).toContain('Vehicle is service-blocked');
  });

  test('a confirmed booking on a ready vehicle is eligible for checkout', async () => {
    install();
    const result = await board();
    const row = result.tabs.checkout.find((r) => r._id === 'b-checkout');
    expect(row.actionGate.checkoutEligible).toBe(true);
    expect(row.actionGate.reasons).toEqual([]);
  });
});

describe('request triage', () => {
  function request(over = {}) {
    return booking({
      _id: 'b-triage',
      status: 'Pending',
      pickupDateTime: '2026-03-10T06:00:00.000Z', // 6h out — inside the ≤12h band
      dropoffDateTime: '2026-03-13T06:00:00.000Z',
      ...over,
    });
  }
  const triageOf = (result) => result.tabs.requests.find((r) => r._id === 'b-triage').requestTriage;

  test('an imminent pickup scores higher than a distant one', async () => {
    install(seed({ BookingsNew: [request()] }));
    const near = triageOf(await board());
    fake.restore();

    install(seed({ BookingsNew: [request({ pickupDateTime: '2026-03-12T06:00:00.000Z' })] }));
    const far = triageOf(await board());

    expect(near.score).toBeGreaterThan(far.score);
    expect(near.reasons).toContain('Pickup in ≤12h');
  });

  test('an unassigned request is flagged for it', async () => {
    install(seed({ BookingsNew: [request()] }));
    expect(triageOf(await board()).reasons).toContain('No assigned vehicle');
  });

  test('an outstanding balance and a pending payment both add weight', async () => {
    install(seed({
      BookingsNew: [request({
        paymentStatus: 'pending',
        financialSnapshot: { settlement: { balance: 250 } },
      })],
    }));
    const triage = triageOf(await board());
    expect(triage.reasons).toContain('Outstanding balance');
    expect(triage.reasons).toContain('Payment pending');
  });

  test('an airport pickup with no flight number is flagged', async () => {
    install(seed({
      BookingsNew: [request({ pickuppoint: 'Athens Airport', flightNumber: '' })],
    }));
    expect(triageOf(await board()).reasons).toContain('Airport transfer without flight');
  });

  test('a flight number clears that flag', async () => {
    install(seed({
      BookingsNew: [request({ pickuppoint: 'Athens Airport', flightNumber: 'A3 992' })],
    }));
    expect(triageOf(await board()).reasons).not.toContain('Airport transfer without flight');
  });

  test('priority and SLA move together, urgent being tightest', async () => {
    install(seed({ BookingsNew: [request()] }));
    const triage = triageOf(await board());
    const expectedSla = { urgent: 1, high: 2, medium: 6, low: 12 }[triage.priority];
    expect(triage.slaHours).toBe(expectedSla);
  });

  test('requests are ordered most urgent first', async () => {
    install(seed({
      BookingsNew: [
        request({ _id: 'b-calm', pickupDateTime: '2026-03-12T06:00:00.000Z' }),
        request({ _id: 'b-triage' }), // 6h out, so it outranks the other
      ],
    }));
    const result = await board();
    expect(ids(result.tabs.requests)[0]).toBe('b-triage');
  });

  // --- Two defects, pinned as they currently behave -------------------------
  // These assert what the code does today, not what it should do. Both are
  // reported alongside this suite; the assertions are written so that fixing
  // either one fails here loudly rather than passing unnoticed.

  test('KNOWN DEFECT: every request is flagged "Assigned vehicle blocked"', async () => {
    // deriveRequestTriage tests `safeText(item.vehicleServiceBlocked)`, but
    // mapBookingLite always sets that field to a real boolean — and
    // safeText(false) is the string "false", which is truthy. So the +20 fires
    // for every request, including ones with no vehicle at all.
    install(seed({
      BookingsNew: [request({ assignedVehicle: '' })], // no vehicle, so nothing can be blocked
    }));
    const triage = triageOf(await board());
    expect(triage.reasons).toContain('Assigned vehicle blocked');
  });

  test('KNOWN DEFECT: the +20 floor means no request is ever "low"', async () => {
    // A request with nothing whatever wrong with it: pickup 72h out (past every
    // urgency band), a ready vehicle already assigned, payment settled. Its
    // score should be 0. The phantom "vehicle blocked" alone contributes 20,
    // which is exactly the "medium" threshold — so the lowest priority the
    // board can ever show is medium, and the "low" lane is dead code.
    install(seed({
      BookingsNew: [request({
        pickupDateTime: '2026-03-13T00:00:00.000Z',
        assignedVehicle: 'car-1',
        paymentStatus: 'paid',
      })],
    }));
    const triage = triageOf(await board());
    expect(triage.reasons).toEqual(['Assigned vehicle blocked']);
    expect(triage.score).toBe(20);
    expect(triage.priority).toBe('medium'); // would be 'low' with a score of 0
  });

  test('KNOWN DEFECT: dueAt equals the window start, ignoring slaHours', async () => {
    // dueAt is addDays(rangeStart, slaHours / 24), but addDays goes through
    // Date#setDate, which truncates its fractional argument to 0. Every SLA
    // deadline is therefore "right now" regardless of priority.
    install(seed({ BookingsNew: [request()] }));
    const triage = triageOf(await board());
    expect(triage.slaHours).toBeGreaterThan(0);
    expect(triage.dueAt).toBe(new Date(START).toISOString());
  });
});

describe('actOnDailyRequest', () => {
  test.each([
    ['accept', 'Confirmed'],
    ['hold', 'Hold'],
    ['escalate', 'Escalated'],
    ['decline', 'Canceled'],
  ])('%s moves the booking to %s', async (action, expected) => {
    install();
    const result = await actOnDailyRequest({ authToken: await token(), bookingId: 'b-request', action });
    expect(result.success).toBe(true);
    expect(bookingRow('b-request').status).toBe(expected);
  });

  test('the action is matched case-insensitively', async () => {
    install();
    const result = await actOnDailyRequest({ authToken: await token(), bookingId: 'b-request', action: 'HOLD' });
    expect(result.success).toBe(true);
    expect(bookingRow('b-request').status).toBe('Hold');
  });

  test('an unknown action is refused and changes nothing', async () => {
    install();
    const before = { ...bookingRow('b-request') };
    const result = await actOnDailyRequest({ authToken: await token(), bookingId: 'b-request', action: 'obliterate' });
    expect(result).toMatchObject({ success: false, message: 'Unknown action' });
    expect(bookingRow('b-request')).toEqual(before);
  });

  test.each([
    ['a missing booking id', { action: 'review' }],
    ['a missing action', { bookingId: 'b-request' }],
  ])('refuses %s', async (_label, args) => {
    install();
    const result = await actOnDailyRequest({ authToken: await token(), ...args });
    expect(result).toMatchObject({ success: false, message: 'Missing params' });
  });

  test('claim records the actor as owner', async () => {
    install();
    const result = await actOnDailyRequest({
      authToken: await token(), bookingId: 'b-request', action: 'claim', actorName: 'Maria',
    });
    expect(result.triageAudit.owner).toBe('Maria');
    expect(bookingRow('b-request').triageOwner).toBe('Maria');
  });

  test('unclaim clears the owner', async () => {
    install();
    const t = await token();
    await actOnDailyRequest({ authToken: t, bookingId: 'b-request', action: 'claim', actorName: 'Maria' });
    const result = await actOnDailyRequest({ authToken: t, bookingId: 'b-request', action: 'unclaim', actorName: 'Maria' });
    expect(result.triageAudit.owner).toBe('');
    expect(bookingRow('b-request').triageOwner).toBe('');
  });

  test('reassign moves ownership to the named target, not the actor', async () => {
    install();
    const result = await actOnDailyRequest({
      authToken: await token(), bookingId: 'b-request', action: 'reassign',
      actorName: 'Maria', targetOwner: 'Nikos',
    });
    expect(result.triageAudit.owner).toBe('Nikos');
  });

  test('reassign without a target is refused before anything is written', async () => {
    install();
    const result = await actOnDailyRequest({
      authToken: await token(), bookingId: 'b-request', action: 'reassign', actorName: 'Maria',
    });
    expect(result).toMatchObject({ success: false, message: 'Missing target owner' });
    expect(bookingRow('b-request').triageOwner).toBeUndefined();
  });

  test('review leaves the status alone but still records the visit', async () => {
    install();
    const before = bookingRow('b-request').status;
    const result = await actOnDailyRequest({
      authToken: await token(), bookingId: 'b-request', action: 'review',
      actorName: 'Maria', note: 'Called, awaiting reply',
    });
    expect(result.success).toBe(true);
    expect(bookingRow('b-request').status).toBe(before);
    expect(result.triageAudit.lastAction).toBe('review');
    expect(result.triageAudit.lastNote).toBe('Called, awaiting reply');
  });

  test('a failed status change does not write an audit entry', async () => {
    // The audit is the record of what an operator did. If the status change
    // fails, saying it happened is worse than saying nothing.
    install(seed({
      StaffRoles: [{
        _id: 'role-ops', key: 'ops', label: 'Ops', active: true,
        bookingsView: true, bookingsEdit: true, rentalsView: true,
        specialPermissions: '', // notably not cancelBooking
      }],
      StaffUsers: [{ _id: 'user-ops', email: ADMIN, fullName: 'Ops', roleKey: 'ops', active: true }],
    }));
    const result = await actOnDailyRequest({
      authToken: await token(), bookingId: 'b-request', action: 'decline', actorName: 'Ops',
    });
    expect(result.success).toBe(false);
    expect(bookingRow('b-request').status).toBe('Pending');
    expect(bookingRow('b-request').triageLastAction).toBeUndefined();
  });

  test('cancelling requires the cancelBooking permission, editing alone is not enough', async () => {
    install(seed({
      StaffRoles: [{
        _id: 'role-ops', key: 'ops', label: 'Ops', active: true,
        bookingsView: true, bookingsEdit: true, rentalsView: true, specialPermissions: '',
      }],
      StaffUsers: [{ _id: 'user-ops', email: ADMIN, fullName: 'Ops', roleKey: 'ops', active: true }],
    }));
    const t = await token();
    // The same operator may hold and escalate...
    await expect(actOnDailyRequest({ authToken: t, bookingId: 'b-request', action: 'hold' }))
      .resolves.toMatchObject({ success: true });
    // ...but not cancel.
    await expect(actOnDailyRequest({ authToken: t, bookingId: 'b-request', action: 'decline' }))
      .resolves.toMatchObject({ success: false });
  });

  test('a role granted cancelBooking may decline', async () => {
    // The converse of the above: the gate keys off the special permission
    // rather than off the role name.
    install(seed({
      StaffRoles: [{
        _id: 'role-ops', key: 'ops', label: 'Ops', active: true,
        bookingsView: true, bookingsEdit: true, rentalsView: true,
        specialPermissions: 'cancelBooking',
      }],
      StaffUsers: [{ _id: 'user-ops', email: ADMIN, fullName: 'Ops', roleKey: 'ops', active: true }],
    }));
    const result = await actOnDailyRequest({ authToken: await token(), bookingId: 'b-request', action: 'decline' });
    expect(result.success).toBe(true);
    expect(bookingRow('b-request').status).toBe('Canceled');
  });
});

describe('the triage audit trail', () => {
  test('each action prepends a line, newest first', async () => {
    install();
    const t = await token();
    await actOnDailyRequest({ authToken: t, bookingId: 'b-request', action: 'review', actorName: 'Maria', note: 'first' });
    const result = await actOnDailyRequest({ authToken: t, bookingId: 'b-request', action: 'hold', actorName: 'Maria', note: 'second' });

    expect(result.triageAudit.historySummary).toHaveLength(2);
    expect(result.triageAudit.historySummary[0]).toContain('second');
    expect(result.triageAudit.historySummary[1]).toContain('first');
  });

  test('a history line names the action and the operator', async () => {
    install();
    const result = await actOnDailyRequest({
      authToken: await token(), bookingId: 'b-request', action: 'review', actorName: 'Maria', note: 'Left voicemail',
    });
    expect(result.triageAudit.historySummary[0]).toContain('REVIEW');
    expect(result.triageAudit.historySummary[0]).toContain('Maria');
    expect(result.triageAudit.historySummary[0]).toContain('Left voicemail');
  });

  test('the history is capped at eight entries', async () => {
    // Unbounded, this array grows on every touch and is written back to the
    // booking each time.
    install();
    const t = await token();
    for (let i = 0; i < 12; i += 1) {
      await actOnDailyRequest({ authToken: t, bookingId: 'b-request', action: 'review', actorName: 'Maria', note: `note-${i}` });
    }
    const stored = bookingRow('b-request').triageHistorySummary;
    expect(stored).toHaveLength(8);
    expect(stored[0]).toContain('note-11'); // newest kept
    expect(stored.join(' ')).not.toContain('note-3'); // oldest dropped
  });

  test('an unnamed operator falls back rather than recording an empty actor', async () => {
    install();
    const result = await actOnDailyRequest({ authToken: await token(), bookingId: 'b-request', action: 'review' });
    expect(result.triageAudit.historySummary[0]).toContain('Operator');
  });

  test('an explicit follow-up time is kept', async () => {
    install();
    const result = await actOnDailyRequest({
      authToken: await token(), bookingId: 'b-request', action: 'review',
      nextFollowUpAt: '2026-03-11T15:00:00.000Z',
    });
    expect(result.triageAudit.nextFollowUpAt).toBe('2026-03-11T15:00:00.000Z');
  });

  test('a later action inherits the follow-up time rather than dropping it', async () => {
    install();
    const t = await token();
    await actOnDailyRequest({
      authToken: t, bookingId: 'b-request', action: 'review', nextFollowUpAt: '2026-03-11T15:00:00.000Z',
    });
    const result = await actOnDailyRequest({ authToken: t, bookingId: 'b-request', action: 'review' });
    expect(result.triageAudit.nextFollowUpAt).toBe('2026-03-11T15:00:00.000Z');
  });

  test('KNOWN DEFECT: hold and escalate set a follow-up of "now" instead of +2h/+1h', async () => {
    // followUpByAction asks addDays for 2/24 and 1/24 of a day, but addDays
    // truncates through Date#setDate, so both are no-ops. The follow-up lands
    // at the moment of the action, which is never in the future.
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
      install();
      const result = await actOnDailyRequest({
        authToken: await token(), bookingId: 'b-request', action: 'hold', actorName: 'Maria',
      });
      expect(result.triageAudit.nextFollowUpAt).toBe('2026-03-10T12:00:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  test('the audit is written with suppressAuth', async () => {
    // wix-data takes options as a third argument. This repo has shipped the
    // options object folded into the item more than once, which silently runs
    // the write without elevated permission.
    install();
    await actOnDailyRequest({ authToken: await token(), bookingId: 'b-request', action: 'review', actorName: 'Maria' });
    const write = fake.calls.update.filter((c) => c.collection === 'BookingsNew').pop();
    expect(write.options).toEqual({ suppressAuth: true });
    expect(write.item.suppressAuth).toBeUndefined();
  });
});
