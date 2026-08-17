import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import { saveContract, saveCheckout, saveCheckin } from '../rentalContract.jsw';

// saveContract is the endpoint behind the whole contract screen: every field an
// operator can edit on a rental arrives here, on both the booking and its rental
// record, and the two are written together. It is also the only place in this
// module that asks what the caller is allowed to do beyond "may edit rentals" —
// changing a price that differs from the snapshot needs `overridePricing`, and
// approving that change needs `approveManualOverride`.
//
// Before this file, nothing past the auth gate ran: rentalLifecycle only proved
// the two legacy wrappers forward their token by watching them fail on a missing
// booking id.
//
// The document/email half at the end of the checkout stage is covered in
// saveContractDocuments.test.js, which stands in for the packages Wix installs
// rather than this repo. Here they are absent, which is itself worth pinning —
// see 'the checkout document pipeline never costs you the save'.

const ADMIN = 'admin@example.com';
const DESK = 'desk@example.com';       // may edit and override, may not approve
const FINANCE = 'finance@example.com'; // may edit and approve, may not override
const CLERK = 'clerk@example.com';     // may edit, nothing else
const PASSWORD = 'correct-horse-battery';
const BOOKING_ID = 'bk-1';

/** Booking with every derived charge field stored, so deriveChargeLines reads the booking. */
function booking(extra = {}) {
  return {
    _id: BOOKING_ID,
    bookingNumber: 'RNT-2026-0001',
    status: 'Confirmed',
    rentalState: '',
    customerName: 'A Customer',
    email: 'customer@example.com',
    phone: '2101234567',
    pickupDateTime: '2026-03-10T08:00:00.000Z',
    dropoffDateTime: '2026-03-13T08:00:00.000Z',
    categoryId: 'ECO',
    baseCost: 135,
    insuranceCost: 36,
    extrasTotal: 0,
    ageFee: 0,
    nightFee: 0,
    totalPrice: 171,
    ...extra,
  };
}

function seed({ bookingRow = booking(), rentals = [] } = {}) {
  const passwordSalt = randomHex(16);
  const cred = (email) => ({
    _id: `cred-${email}`, email, passwordSalt,
    passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true,
  });
  return {
    StaffRoles: [
      { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true },
      // Non-admin roles spell out rentalsEdit; requireStaffAccess short-circuits
      // for admin, so only these exercise the permission map at all.
      {
        _id: 'role-desk', key: 'desk', label: 'Desk', active: true,
        rentalsView: true, rentalsEdit: true, specialPermissions: 'overridePricing',
      },
      {
        _id: 'role-finance', key: 'finance', label: 'Finance', active: true,
        rentalsView: true, rentalsEdit: true, specialPermissions: 'approveManualOverride',
      },
      {
        _id: 'role-clerk', key: 'clerk', label: 'Clerk', active: true,
        rentalsView: true, rentalsEdit: true, specialPermissions: '',
      },
    ],
    StaffUsers: [
      { _id: 'u-admin', email: ADMIN, fullName: 'The Admin', roleKey: 'admin', active: true },
      { _id: 'u-desk', email: DESK, fullName: 'Desk Agent', roleKey: 'desk', active: true },
      { _id: 'u-fin', email: FINANCE, fullName: 'Finance Lead', roleKey: 'finance', active: true },
      { _id: 'u-clerk', email: CLERK, fullName: 'Clerk', roleKey: 'clerk', active: true },
    ],
    StaffCredentials: [cred(ADMIN), cred(DESK), cred(FINANCE), cred(CLERK)],
    StaffSessions: [],
    StaffAuditLog: [],
    BookingsNew: [bookingRow],
    RentalsNew: rentals,
    FleetNew: [],
    VehiclesNew: [],
  };
}

let fake;
function install(options) {
  fake = createFakeWixData(seed(options)).install(wixData);
  return fake;
}
async function token(email = ADMIN) {
  const { sessionToken } = await loginStaff({ email, password: PASSWORD });
  return sessionToken;
}
const bookingRow = () => fake.rows('BookingsNew').find((b) => b._id === BOOKING_ID);
const rentalRow = () => fake.rows('RentalsNew').find((r) => r.bookingId === BOOKING_ID);
const writesTo = (collection) => fake.calls.update.filter((c) => c.collection === collection);

/** Save as `email`, with the booking and roles above already installed. */
async function save(payload, { stage, email = ADMIN } = {}) {
  return saveContract({ authToken: await token(email), bookingId: BOOKING_ID, payload, stage });
}

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('the gate in front of it', () => {
  test('refuses an unauthenticated caller before reading the booking', async () => {
    install();
    await expect(saveContract({ bookingId: BOOKING_ID, payload: {} })).rejects.toThrow('AUTH_REQUIRED');
    expect(fake.rows('RentalsNew')).toHaveLength(0);
    expect(writesTo('BookingsNew')).toHaveLength(0);
  });

  test('refuses a signed-in caller who may only read rentals', async () => {
    const s = seed();
    s.StaffRoles.push({ _id: 'role-ro', key: 'readonly', label: 'Read only', active: true, rentalsView: true });
    s.StaffUsers.push({ _id: 'u-ro', email: 'ro@example.com', fullName: 'RO', roleKey: 'readonly', active: true });
    const passwordSalt = randomHex(16);
    s.StaffCredentials.push({
      _id: 'cred-ro', email: 'ro@example.com', passwordSalt,
      passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true,
    });
    fake = createFakeWixData(s).install(wixData);

    await expect(save({ customerName: 'Changed' }, { email: 'ro@example.com' }))
      .rejects.toThrow('ACCESS_DENIED');
    expect(bookingRow().customerName).toBe('A Customer');
  });

  test('reports a missing booking id rather than throwing', async () => {
    install();
    await expect(saveContract({ authToken: await token(), bookingId: '', payload: {} }))
      .resolves.toMatchObject({ success: false, message: 'Missing bookingId' });
  });

  test('reports an unknown booking rather than throwing', async () => {
    install();
    await expect(saveContract({ authToken: await token(), bookingId: 'nope', payload: {} }))
      .resolves.toMatchObject({ success: false });
  });
});

describe('the rental record', () => {
  test('is created on the first save for a booking that has none', async () => {
    install();
    expect(fake.rows('RentalsNew')).toHaveLength(0);

    await expect(save({})).resolves.toMatchObject({ success: true });

    expect(fake.rows('RentalsNew')).toHaveLength(1);
    expect(rentalRow().bookingId).toBe(BOOKING_ID);
  });

  test('is reused on the second save rather than duplicated', async () => {
    install();
    await save({});
    await save({});
    expect(fake.rows('RentalsNew')).toHaveLength(1);
  });

  test('starts from the booking\'s own charge figures', async () => {
    install();
    await save({});
    expect(rentalRow().charges).toMatchObject({ rental: 135, insurance: 36, gross: 171 });
  });

  test('and the booking is written too — twice, in fact', async () => {
    // saveContract writes the booking, then mirrorToBooking copies the rental's
    // half back onto it and writes it again. Pinned as a count because the
    // second write is where several fields (charges, financials, internalMemo,
    // rentalState) actually reach the booking, so dropping it would look like a
    // save that half worked rather than one that failed.
    install();
    await save({ customerName: 'B Customer' });
    expect(writesTo('BookingsNew')).toHaveLength(2);
    expect(writesTo('RentalsNew')).toHaveLength(1);
  });
});

describe('applying the payload', () => {
  test('leaves a field alone when the payload does not mention it', async () => {
    // Every assignment here is guarded on `!== undefined`, which is the whole
    // reason a partial save from one tab does not wipe what another tab set.
    install();
    await save({ phone: '2109999999' });
    expect(bookingRow().customerName).toBe('A Customer');
    expect(bookingRow().phone).toBe('2109999999');
  });

  test('a save that names none of the customer fields leaves all of them intact', async () => {
    // The test above still mentions phone, so it says nothing about the guard on
    // the phone line itself. Dropping any one of these guards is a payload that
    // blanks a field it never mentioned — the failure mode the guards exist for,
    // and one that only shows up when the field is absent from the payload.
    install();
    await save({ internalMemo: 'nothing to do with the customer' });
    expect(bookingRow()).toMatchObject({
      customerName: 'A Customer',
      phone: '2101234567',
      email: 'customer@example.com',
      bookingNumber: 'RNT-2026-0001',
      categoryId: 'ECO',
    });
  });

  test('clears a field when the payload sends an empty string', async () => {
    install();
    await save({ flightNumber: 'A3 610' });
    expect(bookingRow().flightNumber).toBe('A3 610');
    await save({ flightNumber: '' });
    expect(bookingRow().flightNumber).toBe('');
  });

  test('writes the assigned vehicle onto both records at once', async () => {
    install();
    await save({
      assignedVehicle: 'veh-7',
      assignedVehicleLabel: 'Kia Picanto',
      assignedVehiclePlate: 'ABC-1234',
    });
    expect(bookingRow()).toMatchObject({
      assignedVehicle: 'veh-7', assignedVehicleLabel: 'Kia Picanto', assignedVehiclePlate: 'ABC-1234',
    });
    expect(rentalRow()).toMatchObject({
      assignedVehicleId: 'veh-7', assignedVehicleLabel: 'Kia Picanto', assignedVehiclePlate: 'ABC-1234',
    });
  });

  test('the vehicle id lands on a different field name on each record', async () => {
    // booking.assignedVehicle / rental.assignedVehicleId — easy to conflate, and
    // the contract screen reads one from each.
    install();
    await save({ assignedVehicle: 'veh-7' });
    expect(bookingRow().assignedVehicleId).toBeUndefined();
    expect(rentalRow().assignedVehicle).toBeUndefined();
  });

  test('accepts a date and stores it as a Date', async () => {
    install();
    await save({ pickupDateTime: '2026-03-11T09:30:00.000Z' });
    expect(bookingRow().pickupDateTime).toBeInstanceOf(Date);
    expect(bookingRow().pickupDateTime.toISOString()).toBe('2026-03-11T09:30:00.000Z');
  });

  test('ignores an unparseable date instead of storing garbage', async () => {
    install();
    await save({ dropoffDateTime: 'next Tuesday-ish' });
    expect(String(bookingRow().dropoffDateTime)).toBe('2026-03-13T08:00:00.000Z');
  });

  test('an empty booking status keeps the previous one', async () => {
    // `safeText(payload.bookingStatus) || booking.status` — the only status
    // field written with an `||` fallback rather than replaced outright.
    install();
    await save({ bookingStatus: '' });
    expect(bookingRow().status).toBe('Confirmed');
    await save({ bookingStatus: 'Cancelled' });
    expect(bookingRow().status).toBe('Cancelled');
  });

  test('an extra sent as an object keeps its key; one sent as a bare string has none', async () => {
    // The two halves of normalizeSelectedExtras are not symmetrical: an object
    // is spread, so `key` survives, while a string becomes { label, price: 0 }.
    // Extras are priced by key elsewhere, so a round-trip through the string
    // form is a one-way door — worth knowing before anything starts reading
    // keys off this field.
    install();
    await save({ selectedExtras: ['gps', { key: 'seat', label: 'Child seat', qty: 2 }] });
    const extras = bookingRow().selectedExtras;
    expect(extras).toHaveLength(2);
    expect(extras[0]).toEqual({ label: 'gps', price: 0 });
    expect(extras[1]).toMatchObject({ key: 'seat', label: 'Child seat', qty: 2, price: 0 });
  });

  test('a comma-separated string of extras is split into rows', async () => {
    install();
    await save({ selectedExtras: 'GPS, Child seat ,' });
    expect(bookingRow().selectedExtras).toEqual([
      { label: 'GPS', price: 0 },
      { label: 'Child seat', price: 0 },
    ]);
  });

  test('an unusable extra row is dropped rather than stored blank', async () => {
    install();
    await save({ selectedExtras: ['', null, 42, { price: 5 }] });
    expect(bookingRow().selectedExtras).toEqual([]);
  });

  test('clamps fuel level to the eighths the gauge actually has', async () => {
    install();
    await save({ checkoutFuelLevel: 99, checkinFuelLevel: -4 });
    expect(rentalRow().checkoutFuelLevel).toBe(8);
    expect(rentalRow().checkinFuelLevel).toBe(1);
  });

  test('a null fuel level is left alone rather than clamped to 1', async () => {
    // The clamp is guarded on `!== null` as well as `!== undefined`, so a form
    // that posts an unset select as null does not silently claim an empty tank.
    install();
    await save({ checkoutFuelLevel: 6 });
    await save({ checkoutFuelLevel: null });
    expect(rentalRow().checkoutFuelLevel).toBe(6);
  });

  test('odometer readings go to the rental record and mirror back', async () => {
    install();
    await save({ checkoutOdometer: 41230, checkinOdometer: 41890 });
    expect(rentalRow()).toMatchObject({ checkoutOdometer: 41230, checkinOdometer: 41890 });
    expect(bookingRow()).toMatchObject({ checkoutOdometer: 41230, checkinOdometer: 41890 });
  });

  test('the main driver is stored on the rental and mirrored to the booking', async () => {
    install();
    await save({ mainDriver: { fullName: 'A Driver', licenseNo: 'X-1' } });
    expect(rentalRow().mainDriver).toMatchObject({ fullName: 'A Driver' });
    expect(bookingRow().mainDriver).toMatchObject({ fullName: 'A Driver' });
  });

  test('an omitted driver does not clear the stored one', async () => {
    install();
    await save({ mainDriver: { fullName: 'A Driver' } });
    await save({ internalMemo: 'called the customer' });
    expect(rentalRow().mainDriver).toMatchObject({ fullName: 'A Driver' });
  });
});

describe('the charges block', () => {
  test('a partial charges edit keeps the charges it does not mention', async () => {
    // The regression this block carries a comment about: reading payload.charges
    // instead of the figures applyChargesPayload had just resolved turned every
    // omitted field into 0, and syncBookingChargeFields then wrote those zeros
    // back over both records. Sending one changed field wiped the rest.
    install();
    await save({ charges: { rental: 135, insurance: 36, damages: 0, transport: 25 } });
    expect(rentalRow().charges).toMatchObject({ rental: 135, insurance: 36, transport: 25 });

    await save({ charges: { damages: 40 } });
    expect(rentalRow().charges).toMatchObject({ rental: 135, insurance: 36, transport: 25, damages: 40 });
  });

  test('the booking totals follow the charges, including the manual lines', async () => {
    install();
    await save({ charges: { rental: 135, insurance: 36, transport: 25, discount: 10 } });
    // 135 + 36 + 25 - 10
    expect(bookingRow().totalPrice).toBe(186);
    expect(bookingRow().baseCost).toBe(135);
  });

  test('per-day figures are re-derived from the billable days', async () => {
    // 2026-03-10 08:00 → 2026-03-13 08:00 is exactly three days.
    install();
    await save({ charges: { rental: 150, insurance: 60 } });
    expect(bookingRow().basePricePerDay).toBe(50);
    expect(bookingRow().insuranceExtraPerDay).toBe(20);
  });

  test('the total the charges block computes is discarded before it is stored', async () => {
    // The block writes booking.totalPrice itself, then syncBookingChargeFields
    // recomputes it from the charge lines a few statements later. Only the five
    // named booking fields it sets survive, so the arithmetic on that one line —
    // discount included — is unobservable. Pinned so a future reader does not
    // "fix" a sign there expecting anything to change, and so the five that do
    // survive are stated outright.
    install();
    await save({ charges: { rental: 135, insurance: 36, options: 12, ageFee: 8, nightFee: 5, discount: 10 } });
    expect(bookingRow()).toMatchObject({
      baseCost: 135, insuranceCost: 36, extrasTotal: 12, ageFee: 8, nightFee: 5,
    });
    // 135 + 36 + 12 + 8 + 5 - 10, re-derived rather than carried over.
    expect(bookingRow().totalPrice).toBe(186);
  });

  test('a bare totalPrice is honoured only when no charges came with it', async () => {
    install();
    await save({ totalPrice: 999 });
    // syncBookingChargeFields re-derives the total from the charge lines a few
    // lines later, so the bare value does not survive the save either way.
    expect(bookingRow().totalPrice).toBe(171);
  });

  test('charge lines are rebuilt from the resolved charges', async () => {
    install();
    await save({ charges: { rental: 135, insurance: 36, damages: 40 } });
    const codes = rentalRow().chargeLines.map((l) => l.code);
    expect(codes).toEqual(expect.arrayContaining(['rental_base', 'insurance', 'damage_fee']));
    const damage = rentalRow().chargeLines.find((l) => l.code === 'damage_fee');
    expect(damage.amount).toBe(40);
  });

  test('a discount line is kept even at zero, unlike the other lines', async () => {
    install();
    await save({ charges: { rental: 135, insurance: 36 } });
    const codes = rentalRow().chargeLines.map((l) => l.code);
    expect(codes).toContain('discount');
    expect(codes).not.toContain('damage_fee');
  });

  test('a charge-lines-only payload changes the itemisation, not the figures', async () => {
    install();
    await save({ charges: { rental: 135, insurance: 36, damages: 40 } });
    await save({ chargeLines: [{ code: 'damage_fee', amount: 40, label: 'Kerbed alloy' }] });
    expect(rentalRow().charges).toMatchObject({ rental: 135, insurance: 36, damages: 40 });
    expect(rentalRow().chargeLines.find((l) => l.code === 'damage_fee').label).toBe('Kerbed alloy');
  });

  test('an explicit charges: null does not throw', async () => {
    // typeof null === "object", so it reaches applyChargesPayload as a supplied
    // half rather than being filtered out.
    install();
    await expect(save({ charges: null })).resolves.toMatchObject({ success: true });
  });

  test('the VAT split follows the billing rate rather than the 24% default', async () => {
    install();
    await save({ billing: { vatRate: 0.13 }, charges: { rental: 100, insurance: 13 } });
    expect(rentalRow().totals.gross).toBe(113);
    expect(rentalRow().totals.net + rentalRow().totals.vat).toBeCloseTo(113, 2);
    expect(rentalRow().totals.vat).toBeCloseTo(113 - 113 / 1.13, 2);
  });
});

describe('the stage argument', () => {
  test('checkout puts both records into Active Rental', async () => {
    install();
    await save({}, { stage: 'checkout' });
    expect(rentalRow().rentalState).toBe('Active Rental');
    expect(bookingRow().rentalState).toBe('Active Rental');
  });

  test('pre puts both into Pre Check-In and sets the stage', async () => {
    install();
    await save({}, { stage: 'pre' });
    expect(rentalRow()).toMatchObject({ rentalState: 'Pre Check-In', checkinStage: 'Pre Check-In' });
    expect(bookingRow().rentalState).toBe('Pre Check-In');
  });

  test('final closes the rental', async () => {
    install();
    await save({}, { stage: 'final' });
    expect(rentalRow()).toMatchObject({ rentalState: 'Closed Rental', checkinStage: 'Closed Rental' });
    expect(bookingRow().rentalState).toBe('Closed Rental');
  });

  test('is matched case-insensitively', async () => {
    install();
    await save({}, { stage: 'CheckOut' });
    expect(rentalRow().rentalState).toBe('Active Rental');
  });

  test('an unrecognised stage saves without changing the rental state', async () => {
    install();
    await save({}, { stage: 'whatever' });
    expect(rentalRow().rentalState).toBe('Booking');
  });

  test('no stage at all saves without changing the rental state', async () => {
    install();
    await save({ internalMemo: 'note' });
    expect(rentalRow().rentalState).toBe('Booking');
    expect(rentalRow().internalMemo).toBe('note');
  });

  // Compared to the millisecond. String(date) prints to the second, so two
  // saves inside the same second read as equal whether the timestamp moved or
  // not — a re-stamp on every save would slip straight through.
  const stampOf = (value) => new Date(value).getTime();

  test('the checkout timestamp is stamped once and not moved by a later save', async () => {
    install();
    await save({}, { stage: 'checkout' });
    const first = rentalRow().checkoutAt;
    expect(first).toBeTruthy();
    await save({ internalMemo: 'again' }, { stage: 'checkout' });
    expect(stampOf(rentalRow().checkoutAt)).toBe(stampOf(first));
  });

  test('the check-in timestamp is stamped once too', async () => {
    install();
    await save({}, { stage: 'final' });
    const first = rentalRow().checkinAt;
    expect(first).toBeTruthy();
    await save({}, { stage: 'final' });
    expect(stampOf(rentalRow().checkinAt)).toBe(stampOf(first));
  });

  test('checkout freezes a copy of the financial snapshot on both records', async () => {
    install();
    await save({ charges: { rental: 135, insurance: 36, damages: 40 } }, { stage: 'checkout' });
    expect(rentalRow().checkoutFinancialSnapshot).toBeTruthy();
    expect(bookingRow().checkoutFinancialSnapshot).toBeTruthy();
  });

  test('a stage that is not checkout leaves that frozen copy alone', async () => {
    install();
    await save({}, { stage: 'pre' });
    expect(rentalRow().checkoutFinancialSnapshot).toBeUndefined();
  });

  test('the wrappers pass their stage through', async () => {
    install();
    const t = await token();
    await saveCheckout({ authToken: t, bookingId: BOOKING_ID, payload: {} });
    expect(rentalRow().rentalState).toBe('Active Rental');
    await saveCheckin({ authToken: t, bookingId: BOOKING_ID, payload: {} });
    expect(rentalRow().rentalState).toBe('Closed Rental');
  });
});

describe('the pricing override gate', () => {
  // A booking that already carries a snapshot, so a changed figure is drift
  // rather than the first thing anyone recorded.
  const withSnapshot = () => booking({
    pricingSnapshot: {
      rental: 135, insurance: 36, options: 0, ageFee: 0, nightFee: 0,
      transport: 0, damages: 0, surcharges: 0, discount: 0, gross: 171, days: 3,
      capturedAt: '2026-03-01T00:00:00.000Z',
    },
  });

  test('an ordinary save that changes nothing priced is allowed for anyone who may edit', async () => {
    install({ bookingRow: withSnapshot() });
    await expect(save({ internalMemo: 'called ahead' }, { email: CLERK }))
      .resolves.toMatchObject({ success: true });
    expect(rentalRow().pricingOverride.status).toBe('clean');
  });

  test('changing a price without overridePricing is refused', async () => {
    install({ bookingRow: withSnapshot() });
    const res = await save({ charges: { rental: 135, insurance: 36, damages: 40 } }, { email: CLERK });
    expect(res.success).toBe(false);
    expect(res.message).toContain('ACCESS_DENIED');
    expect(res.message).toContain('pricing override permission');
  });

  test('and nothing is written when it is refused', async () => {
    // The refusal returns before either update, so a caller who cannot override
    // does not leave half a save behind. The rental record itself is still
    // created — ensureRentalForBooking runs before the gate — but neither
    // record takes the payload.
    install({ bookingRow: withSnapshot() });
    await save({ charges: { rental: 135, insurance: 36, damages: 40 }, internalMemo: 'sneak' }, { email: CLERK });

    expect(writesTo('BookingsNew')).toHaveLength(0);
    expect(writesTo('RentalsNew')).toHaveLength(0);
    expect(bookingRow().totalPrice).toBe(171);
    // The rental keeps the empty memo ensureRentalForBooking gave it, not the
    // one the refused payload carried.
    expect(rentalRow().internalMemo).toBe('');
  });

  test('changing a price with overridePricing is allowed and recorded as an override', async () => {
    install({ bookingRow: withSnapshot() });
    const res = await save({ charges: { rental: 135, insurance: 36, damages: 40 } }, { email: DESK });
    expect(res.success).toBe(true);
    expect(bookingRow().totalPrice).toBe(211);
  });

  test('the override records who asked, what changed and by how much', async () => {
    install({ bookingRow: withSnapshot() });
    await save({
      charges: { rental: 135, insurance: 36, damages: 40 },
      pricingOverride: { reason: 'Kerbed alloy', note: 'photos on file' },
    }, { email: DESK });

    expect(rentalRow().pricingOverride).toMatchObject({
      reason: 'Kerbed alloy',
      note: 'photos on file',
      deltaGross: 40,
      requestedBy: 'Desk Agent',
      requestedByEmail: DESK,
    });
  });

  test('a desk agent, who cannot approve, leaves the override pending', async () => {
    install({ bookingRow: withSnapshot() });
    await save({ charges: { rental: 135, insurance: 36, damages: 40 } }, { email: DESK });
    expect(rentalRow().pricingOverride.status).toBe('pendingApproval');
  });

  test('an admin who does not ask for approval records a plain override', async () => {
    install({ bookingRow: withSnapshot() });
    await save({ charges: { rental: 135, insurance: 36, damages: 40 } }, { email: ADMIN });
    expect(rentalRow().pricingOverride.status).toBe('override');
  });

  test('an admin can ask for approval anyway, and it goes pending', async () => {
    install({ bookingRow: withSnapshot() });
    await save({
      charges: { rental: 135, insurance: 36, damages: 40 },
      pricingOverride: { requestApproval: true },
    }, { email: ADMIN });
    expect(rentalRow().pricingOverride.status).toBe('pendingApproval');
  });

  test('an admin can approve in the same save, and is stamped as the approver', async () => {
    install({ bookingRow: withSnapshot() });
    await save({
      charges: { rental: 135, insurance: 36, damages: 40 },
      pricingOverride: { approveNow: true, reason: 'Damage agreed with customer' },
    }, { email: ADMIN });

    expect(rentalRow().pricingOverride).toMatchObject({
      status: 'approved', approvedBy: 'The Admin', approvedByEmail: ADMIN,
    });
    expect(rentalRow().pricingOverride.approvedAt).toBeTruthy();
  });

  test('approving without the approval permission is refused', async () => {
    install({ bookingRow: withSnapshot() });
    const res = await save({
      charges: { rental: 135, insurance: 36, damages: 40 },
      pricingOverride: { approveNow: true },
    }, { email: DESK });

    expect(res.success).toBe(false);
    expect(res.message).toContain('manual override approval permission');
  });

  test('the approval check runs even when nothing priced changed', async () => {
    // approveNow is refused on its own terms, before drift is consulted — so a
    // caller cannot probe for the permission with a harmless save.
    install({ bookingRow: withSnapshot() });
    const res = await save({ pricingOverride: { approveNow: true } }, { email: CLERK });
    expect(res.success).toBe(false);
    expect(res.message).toContain('manual override approval permission');
  });

  test('approval permission alone does not let you change the price', async () => {
    // Finance may approve but not override, so the second gate still stops it.
    install({ bookingRow: withSnapshot() });
    const res = await save({
      charges: { rental: 135, insurance: 36, damages: 40 },
      pricingOverride: { approveNow: true },
    }, { email: FINANCE });

    expect(res.success).toBe(false);
    expect(res.message).toContain('pricing override permission');
  });

  test('a change under a cent is not treated as drift', async () => {
    install({ bookingRow: withSnapshot() });
    const res = await save({ charges: { rental: 135.004, insurance: 36 } }, { email: CLERK });
    expect(res.success).toBe(true);
  });

  test('a one-cent change is', async () => {
    install({ bookingRow: withSnapshot() });
    const res = await save({ charges: { rental: 135.01, insurance: 36 } }, { email: CLERK });
    expect(res.success).toBe(false);
  });

  test('a discount is drift too, not just an added charge', async () => {
    install({ bookingRow: withSnapshot() });
    const res = await save({ charges: { rental: 135, insurance: 36, discount: 20 } }, { email: CLERK });
    expect(res.success).toBe(false);
    expect(bookingRow().totalPrice).toBe(171);
  });

  test('money moved between lines is drift even though the total is unchanged', async () => {
    // A 20 transport fee cancelled by a 20 discount leaves the gross at exactly
    // 171. Drift is decided line by line rather than on the total, so this is
    // still an override — which is the point: the customer is being charged for
    // something different, and the two halves could be unwound separately.
    install({ bookingRow: withSnapshot() });
    const res = await save({
      charges: { rental: 135, insurance: 36, transport: 20, discount: 20 },
    }, { email: CLERK });

    expect(res.success).toBe(false);
    expect(res.message).toContain('pricing override permission');
  });

  test('and the delta reported for it is zero, since the total really did not move', async () => {
    install({ bookingRow: withSnapshot() });
    await save({
      charges: { rental: 135, insurance: 36, transport: 20, discount: 20 },
    }, { email: ADMIN });

    expect(rentalRow().pricingOverride).toMatchObject({ status: 'override', deltaGross: 0 });
    expect(rentalRow().pricingReview.drift.hasDelta).toBe(true);
  });

  test('an admin reaches both permissions through the special list, not a separate check', async () => {
    // requireStaffAccess fills every special in for an admin role, so the
    // isAdmin term in saveContract's own two checks never decides anything on
    // its own. Pinned because the two look like independent grants and are not:
    // an admin who somehow arrived with an empty special list would still pass,
    // and this is the record of which of those is load-bearing.
    install({ bookingRow: withSnapshot() });
    await save({
      charges: { rental: 135, insurance: 36, damages: 40 },
      pricingOverride: { approveNow: true },
    }, { email: ADMIN });
    expect(rentalRow().pricingOverride.status).toBe('approved');

    // The same save by a role holding both specials explicitly, and no admin
    // flag at all, lands identically.
    const s = seed({ bookingRow: withSnapshot() });
    s.StaffRoles.push({
      _id: 'role-both', key: 'super', label: 'Super', active: true,
      rentalsView: true, rentalsEdit: true,
      specialPermissions: 'overridePricing|approveManualOverride',
    });
    s.StaffUsers.push({ _id: 'u-both', email: 'both@example.com', fullName: 'Both', roleKey: 'super', active: true });
    const passwordSalt = randomHex(16);
    s.StaffCredentials.push({
      _id: 'cred-both', email: 'both@example.com', passwordSalt,
      passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true,
    });
    fake.restore();
    fake = createFakeWixData(s).install(wixData);

    await save({
      charges: { rental: 135, insurance: 36, damages: 40 },
      pricingOverride: { approveNow: true },
    }, { email: 'both@example.com' });
    expect(rentalRow().pricingOverride).toMatchObject({ status: 'approved', approvedBy: 'Both' });
  });

  test('the stored snapshot is what drift is measured against, not the last save', async () => {
    install({ bookingRow: withSnapshot() });
    await save({ charges: { rental: 135, insurance: 36, damages: 40 } }, { email: ADMIN });
    // The snapshot is written back unchanged, so the next save is measured from
    // the original 171 rather than from the 211 just recorded.
    expect(bookingRow().pricingSnapshot.gross).toBe(171);
    const res = await save({ charges: { rental: 135, insurance: 36, damages: 40 } }, { email: CLERK });
    expect(res.success).toBe(false);
  });

  test('a booking with no snapshot yet gets one from its own figures, and no drift', async () => {
    install();
    const res = await save({ internalMemo: 'first touch' }, { email: CLERK });
    expect(res.success).toBe(true);
    expect(bookingRow().pricingSnapshot).toMatchObject({ gross: 171, days: 3 });
  });

  test('the clean record keeps a previous approval rather than erasing it', async () => {
    install({ bookingRow: withSnapshot() });
    await save({
      charges: { rental: 135, insurance: 36, damages: 40 },
      pricingOverride: { approveNow: true },
    }, { email: ADMIN });
    // Put the figures back, so the next save is clean again.
    await save({ charges: { rental: 135, insurance: 36, damages: 0 } }, { email: ADMIN });

    expect(rentalRow().pricingOverride).toMatchObject({ status: 'clean', deltaGross: 0, approvedBy: 'The Admin' });
  });

  test('the pricing review is stored alongside, holding both sides of the comparison', async () => {
    install({ bookingRow: withSnapshot() });
    await save({ charges: { rental: 135, insurance: 36, damages: 40 } }, { email: ADMIN });

    const review = rentalRow().pricingReview;
    expect(review.snapshot.gross).toBe(171);
    expect(review.working.gross).toBe(211);
    expect(review.drift.hasDelta).toBe(true);
    expect(review.drift.lineItems.find((l) => l.key === 'damages')).toMatchObject({ delta: 40, changed: true });
  });
});

describe('what a save leaves behind for the rest of the screen', () => {
  test('the financial snapshot is written to both records', async () => {
    install();
    await save({ financials: { prepaid: 50, paymentMethod: 'card' } });
    expect(rentalRow().financialSnapshot).toBeTruthy();
    expect(bookingRow().financialSnapshot).toBeTruthy();
    expect(bookingRow().paymentMethod).toBe('card');
    expect(bookingRow().prepaidAmount).toBe(50);
  });

  test('the commercial state settles once the balance is covered', async () => {
    install();
    await save({ financials: { prepaid: 171 } });
    expect(rentalRow().commercialState).toMatchObject({ settlementState: 'settled', outstanding: 0 });
  });

  test('a part payment is reported as partial, with what is left', async () => {
    install();
    await save({ financials: { prepaid: 71 } });
    expect(rentalRow().commercialState).toMatchObject({ settlementState: 'partial', outstanding: 100, paidTotal: 71 });
  });

  test('nothing paid is open', async () => {
    install();
    await save({ financials: { prepaid: 0 } });
    expect(rentalRow().commercialState).toMatchObject({ settlementState: 'open', paidTotal: 0 });
  });

  test('financial transactions are stored on both records, dropping the unusable rows', async () => {
    install();
    await save({
      financialTransactions: [
        { type: 'payment', amount: 100, method: 'card' },
        { type: 'refund', amount: 20 },
        { type: 'payment', amount: 0 },      // no amount — dropped
        null,                                 // not a row — dropped
      ],
    });
    const rows = rentalRow().financialTransactions;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ type: 'payment', amount: 100, signedAmount: 100, category: 'payment' });
    expect(rows[1]).toMatchObject({ type: 'refund', amount: 20, signedAmount: -20, category: 'refund' });
    expect(bookingRow().financialTransactions).toHaveLength(2);
  });

  test('the signature state is normalised and mirrored', async () => {
    install();
    await save({ signatureState: { status: 'captured', signerName: 'A Customer' } });
    expect(rentalRow().signatureState).toMatchObject({ status: 'captured', signerName: 'A Customer' });
    expect(bookingRow().signatureState).toMatchObject({ status: 'captured' });
  });

  test('an unrecognised signature status falls back to not_started', async () => {
    install();
    await save({ signatureState: { status: 'scribbled' } });
    expect(rentalRow().signatureState.status).toBe('not_started');
  });

  test('a guardrail override needs a reason to be recorded at all', async () => {
    install();
    await save({ checkoutGuardrailOverride: { actor: 'Desk' } });
    expect(rentalRow().checkoutGuardrailOverride).toBeNull();

    await save({ checkoutGuardrailOverride: { reason: 'Customer waited 40 minutes', actor: 'Desk' } });
    expect(rentalRow().checkoutGuardrailOverride).toMatchObject({ reason: 'Customer waited 40 minutes', actor: 'Desk' });
  });

  test('an existing guardrail override survives a save that omits it', async () => {
    install();
    await save({ checkoutGuardrailOverride: { reason: 'Customer waited 40 minutes' } });
    await save({ internalMemo: 'note' });
    expect(rentalRow().checkoutGuardrailOverride).toMatchObject({ reason: 'Customer waited 40 minutes' });
  });

  test('the document pipeline snapshot is rebuilt on both records', async () => {
    install();
    await save({});
    expect(rentalRow().documentPipeline).toBeTruthy();
    expect(bookingRow().documentPipeline).toBeTruthy();
  });

  test('the response carries the state the screen re-renders from', async () => {
    install();
    const res = await save({ charges: { rental: 135, insurance: 36 } }, { stage: 'pre' });
    expect(res).toMatchObject({ success: true, rentalState: 'Pre Check-In', checkinStage: 'Pre Check-In' });
    expect(res.totals.gross).toBe(171);
  });
});

describe('failures', () => {
  test('a write failure is reported as a message rather than thrown', async () => {
    install();
    const t = await token();
    // Break only the write path, after the login above has used it, so the
    // reads still work and the failure lands where the save persists.
    wixData.update = () => Promise.reject(new Error('collection is offline'));

    await expect(saveContract({ authToken: t, bookingId: BOOKING_ID, payload: {} }))
      .resolves.toMatchObject({ success: false, message: 'collection is offline' });
  });

  test('the checkout document pipeline never costs you the save', async () => {
    // @sendgrid/mail and pdfkit are installed by Wix, not by this repo, so the
    // require at the top of the checkout block throws here. That is the same
    // shape as the pipeline being unavailable in production, and the promise the
    // block makes is that it cannot fail the save: the records are written
    // before it runs, and its catch still answers success with a warning.
    install();
    const res = await save({ charges: { rental: 135, insurance: 36, damages: 40 } }, { stage: 'checkout' });

    expect(res.success).toBe(true);
    expect(res.warning).toMatch(/PDF\/email failed/);
    expect(res.rentalState).toBe('Active Rental');
    expect(bookingRow().rentalState).toBe('Active Rental');
    expect(bookingRow().totalPrice).toBe(211);
  });
});
