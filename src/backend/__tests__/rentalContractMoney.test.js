import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import { saveContract } from '../rentalContract.jsw';

// The money half of saveContract: what an operator's edits do to the stored
// charges, billing, financials and transaction list.
//
// rentalContract.test.js covers the pure calculators (VAT, charge lines) and
// rentalLifecycle.test.js covers checkout and check-in; neither writes money.
// These four payload sections are applied to the rental *and* mirrored onto the
// booking, so a mistake here does not throw — it leaves two records disagreeing
// about what the customer owes, and whichever screen the operator opens next
// decides which answer they see.
//
// The document and PDF paths are still out of scope: they depend on puppeteer
// and pdfkit, which Velo supplies rather than this repo.

const STAFF = 'staff@example.com';
const PASSWORD = 'correct-horse-battery';
const BOOKING_ID = 'bk-1';

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
    BookingsNew: [{
      _id: BOOKING_ID,
      bookingNumber: 'RNT-2026-0001',
      status: 'Confirmed',
      customerName: 'A Customer',
      email: 'customer@example.com',
      pickupDateTime: '2026-03-10T09:00:00.000Z',
      dropoffDateTime: '2026-03-13T09:00:00.000Z',
      baseCost: 135,
      insuranceCost: 36,
      totalPrice: 171,
    }],
    RentalsNew: [],
    FleetNew: [],
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
async function save(payload, stage = 'checkout') {
  const result = await saveContract({ authToken: await token(), bookingId: BOOKING_ID, payload, stage });
  // saveContract catches everything and reports success:false, so a thrown
  // error would otherwise read as a save that simply declined.
  expect(result.success).toBe(true);
  return result;
}
const rental = () => fake.rows('RentalsNew')[0];
const booking = () => fake.rows('BookingsNew').find((b) => b._id === BOOKING_ID);

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('charges', () => {
  test('the figures an operator enters are what gets stored', async () => {
    install();
    await save({ charges: { rental: 135, insurance: 36, damages: 40, discount: 15 } });

    expect(rental().charges).toMatchObject({ rental: 135, insurance: 36, damages: 40, discount: 15 });
  });

  test('a partial edit keeps the charges it does not mention', async () => {
    // The checkout screen may send only what changed. This used to drop every
    // other charge to zero: applyChargesPayload preserved them, then the block
    // after it read the raw payload, wrote 0 for each omitted field onto the
    // booking, and syncBookingChargeFields merged those zeros back over the
    // rental. The customer's total fell to just the field that was edited.
    install();
    await save({ charges: { rental: 135, insurance: 36, damages: 40 } });
    await save({ charges: { damages: 55 } });

    expect(rental().charges).toMatchObject({ rental: 135, insurance: 36, damages: 55 });
    expect(booking().baseCost).toBe(135);
    expect(booking().insuranceCost).toBe(36);
    expect(booking().totalPrice).toBe(226); // 135 + 36 + 55
  });

  test('a partial edit keeps the charges that have no booking field of their own', async () => {
    // transport, damages, surcharges and discount are carried only on the
    // rental, and the booking's total is recomputed from there by
    // syncBookingChargeFields. So this asserts applyChargesPayload's own
    // fallback rather than the fix above — the block the fix touches writes a
    // totalPrice that is overwritten a few lines later and cannot be observed.
    install();
    await save({ charges: { rental: 100, transport: 20, surcharges: 10, discount: 5 } });
    await save({ charges: { damages: 15 } });

    expect(rental().charges).toMatchObject({ rental: 100, transport: 20, surcharges: 10, discount: 5, damages: 15 });
    // 100 rental + 36 insurance + 20 transport + 10 surcharges + 15 damages - 5 discount.
    // The 36 is the booking's insuranceCost, carried into the rental draft by
    // ensureRentalForBooking and then preserved by every partial edit — which
    // is the behaviour under test.
    expect(booking().totalPrice).toBe(176);
  });

  test('an explicit zero still clears a charge', async () => {
    // "Set this to nothing" must not become "leave it alone" — waiving a fee is
    // a real edit, and `??` rather than `||` is what keeps the two apart. The
    // distinction lives in applyChargesPayload; the recomputed total follows
    // from it.
    install();
    await save({ charges: { rental: 135, damages: 40 } });
    await save({ charges: { damages: 0 } });

    expect(rental().charges).toMatchObject({ rental: 135, damages: 0 });
    expect(booking().totalPrice).toBe(171); // 135 rental + 36 insurance, damages waived
  });

  test('a full charges edit round-trips every field', async () => {
    // The shape the screen is presumed to send: everything, every time.
    install();
    await save({ charges: { rental: 135, insurance: 36, damages: 40 } });
    await save({ charges: { rental: 135, insurance: 36, damages: 55 } });

    expect(rental().charges).toMatchObject({ rental: 135, insurance: 36, damages: 55 });
  });

  test.each([
    ['a non-numeric amount', 'lots'],
    ['null', null],
    ['an empty string', ''],
  ])('%s becomes zero rather than NaN', async (_label, damages) => {
    install();
    await save({ charges: { rental: 100, damages } });
    expect(rental().charges.damages).toBe(0);
    expect(Number.isFinite(rental().charges.rental)).toBe(true);
  });

  test('charge lines are rebuilt from the charges', async () => {
    // The lines are what the printed contract itemises; leaving them stale
    // would show the customer a total that does not match the figures.
    install();
    await save({ charges: { rental: 100, damages: 40 } });

    const kinds = (rental().chargeLines || []).map((l) => l.key);
    expect(kinds).toContain('rental');
    expect(kinds).toContain('damages');
  });

  test('charge lines can be edited without resending the figures', async () => {
    // The guard lets either half of the payload through alone, so `ch` can be
    // null here. Reading it directly used to throw, and the outer catch turned
    // that into a failure naming a null dereference — nothing an operator could
    // act on. Editing the itemisation now leaves the figures as they were.
    install();
    await save({ charges: { rental: 135, damages: 40 } });

    const result = await saveContract({
      authToken: await token(), bookingId: BOOKING_ID, stage: 'checkout',
      payload: { chargeLines: [{ key: 'damages', label: 'Dented rear door', amount: 40 }] },
    });

    expect(result.success).toBe(true);
    expect(rental().charges).toMatchObject({ rental: 135, damages: 40 });
  });

  test('a relabelled charge line keeps its label', async () => {
    // The point of sending lines alone: the figures are agreed, the wording on
    // the printed contract is not. Identified by `code`, which is what
    // buildChargeLinesFromCharges matches on.
    install();
    await save({ charges: { rental: 135, damages: 40 } });
    await save({ chargeLines: [{ code: 'damage_fee', label: 'Dented rear door', amount: 40 }] });

    const line = (rental().chargeLines || []).find((l) => l.key === 'damages');
    expect(line.label).toBe('Dented rear door');
  });

  test('a line identified only by its key keeps its label too', async () => {
    // Lines are matched on `code` — 'damage_fee' — while the charge is keyed
    // 'damages'. normalizeChargeLinesPayload falls `code` back to `key`, so a
    // caller sending { key: 'damages' } produced code 'damages', matching no
    // spec: the amount applied but the label silently reverted to the default.
    install();
    await save({ charges: { rental: 135, damages: 40 } });
    await save({ chargeLines: [{ key: 'damages', label: 'Dented rear door', amount: 40 }] });

    const line = (rental().chargeLines || []).find((l) => l.key === 'damages');
    expect(line.label).toBe('Dented rear door');
    expect(line.amount).toBe(40);
  });

  test('an explicit code still wins over a key that points elsewhere', async () => {
    // The fallback must not let a stray key override a caller that named the
    // code outright.
    install();
    await save({ charges: { rental: 135, damages: 40 } });
    await save({ chargeLines: [
      { code: 'damage_fee', label: 'By code', amount: 40 },
      { key: 'damages', label: 'By key', amount: 40 },
    ] });

    const line = (rental().chargeLines || []).find((l) => l.key === 'damages');
    expect(line.label).toBe('By code');
  });

  test('an explicit null charges object is treated as no figures, not as a crash', async () => {
    // `typeof null === "object"`, so a null slips past the type check above and
    // reaches the same dereference.
    install();
    await save({ charges: { rental: 135 } });

    const result = await saveContract({
      authToken: await token(), bookingId: BOOKING_ID, stage: 'checkout',
      payload: { charges: null, chargeLines: [{ key: 'rental', label: 'Rental', amount: 135 }] },
    });

    expect(result.success).toBe(true);
    expect(rental().charges.rental).toBe(135);
  });

  test('a payload with no charges section leaves the stored charges alone', async () => {
    install();
    await save({ charges: { rental: 135 } });
    await save({ billing: { city: 'Thessaloniki' } });

    expect(rental().charges.rental).toBe(135);
  });
});

describe('billing and VAT', () => {
  test('the VAT rate an operator sets is stored', async () => {
    install();
    await save({ billing: { vatRate: 0.13 } });
    expect(rental().billing.vatRate).toBe(0.13);
  });

  test.each([
    ['above one', 5, 1],
    ['a percentage mistaken for a rate', 24, 1],
    ['negative', -0.5, 0],
  ])('a VAT rate %s is clamped to a real rate', async (_label, vatRate, expected) => {
    // The rate multiplies the whole invoice. A 24 entered where 0.24 was meant
    // would otherwise bill twenty-four times the amount.
    install();
    await save({ billing: { vatRate } });
    expect(rental().billing.vatRate).toBe(expected);
  });

  test('a non-numeric VAT rate falls back rather than becoming NaN', async () => {
    install();
    await save({ billing: { vatRate: 'standard' } });
    expect(Number.isFinite(rental().billing.vatRate)).toBe(true);
  });

  test('VAT is inclusive unless said otherwise', async () => {
    install();
    await save({ billing: { companyName: 'Acme' } });
    expect(rental().billing.vatInclusive).toBe(true);
  });

  test('VAT can be set exclusive, and stays a boolean', async () => {
    install();
    await save({ billing: { vatInclusive: false } });
    expect(rental().billing.vatInclusive).toBe(false);
  });

  test.each([
    ['a truthy string', 'no', true],
    ['the number one', 1, true],
    ['zero', 0, false],
    ['an empty string', '', false],
  ])('%s is stored as a real boolean, not as itself', async (_label, vatInclusive, expected) => {
    // Stored as given, a string would read as true on one screen and be
    // rendered literally on another. The flag decides whether VAT is added to
    // the total or taken out of it.
    install();
    await save({ billing: { vatInclusive } });
    expect(rental().billing.vatInclusive).toBe(expected);
  });

  test('company details are kept across a later partial edit', async () => {
    install();
    await save({ billing: { companyName: 'Acme AE', vatNumber: 'EL123456789' } });
    await save({ billing: { city: 'Thessaloniki' } });

    expect(rental().billing).toMatchObject({
      companyName: 'Acme AE', vatNumber: 'EL123456789', city: 'Thessaloniki',
    });
  });
});

describe('financials', () => {
  test('the payment fields an operator sets are stored', async () => {
    install();
    await save({ financials: { paymentMethod: 'card', paymentStatus: 'paid', prepaid: 50 } });

    expect(rental().financials).toMatchObject({ paymentMethod: 'card', paymentStatus: 'paid', prepaid: 50 });
  });

  test.each([
    ['paymentMethod', 'cash'],
    ['paymentStatus', 'pending'],
    ['collectionMode', 'pay_arrival'],
  ])('%s defaults to %s rather than to an empty string', async (field, expected) => {
    // These are read back as flags on the ops screens; an empty value there
    // reads as "unknown" and sends someone to check.
    install();
    await save({ financials: {} });
    expect(rental().financials[field]).toBe(expected);
  });

  test.each([
    ['paymentMethod', 'cash'],
    ['paymentStatus', 'pending'],
    ['collectionMode', 'pay_arrival'],
  ])('an explicitly empty %s falls back rather than being stored blank', async (field, expected) => {
    install();
    await save({ financials: { [field]: '' } });
    expect(rental().financials[field]).toBe(expected);
  });

  test.each([['prepaid'], ['paidNow'], ['deposit']])('%s coerces a non-numeric value to zero', async (field) => {
    install();
    await save({ financials: { [field]: 'some' } });
    expect(rental().financials[field]).toBe(0);
  });

  test('the booking is updated to agree with the rental', async () => {
    // Both records carry these fields and different screens read different
    // ones. If they drift, the answer depends on which screen you opened.
    install();
    await save({ financials: { paymentMethod: 'card', paymentStatus: 'paid', deposit: 200 } });

    expect(booking().paymentMethod).toBe('card');
    expect(booking().paymentStatus).toBe('paid');
    expect(booking().depositAmount).toBe(200);
    expect(booking().financials).toMatchObject({ paymentMethod: 'card', deposit: 200 });
  });

  test('the flattened fields on the rental agree with the nested ones', async () => {
    install();
    await save({ financials: { prepaid: 30, paidNow: 20, deposit: 100 } });

    expect(rental().prepaidAmount).toBe(rental().financials.prepaid);
    expect(rental().paidNowAmount).toBe(rental().financials.paidNow);
    expect(rental().depositAmount).toBe(rental().financials.deposit);
  });
});

describe('financial transactions', () => {
  const txn = (over = {}) => ({ type: 'payment', amount: 100, method: 'card', ...over });
  const rows = () => rental().financialTransactions || [];

  test('a posted payment is recorded', async () => {
    install();
    await save({ financialTransactions: [txn()] });

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ type: 'payment', amount: 100, method: 'card' });
  });

  test.each([
    ['refund', -100],
    ['guarantee_refund', -100],
    ['preauth_void', -100],
    ['payment', 100],
    ['deposit', 100],
  ])('a %s is signed %i', async (type, expected) => {
    // The signed amount is what a balance is summed from. A refund stored
    // positive does not fail — it silently doubles the customer's payment.
    install();
    await save({ financialTransactions: [txn({ type })] });
    expect(rows()[0].signedAmount).toBe(expected);
  });

  test('a refund entered as a negative amount is still stored as a negative', async () => {
    // Operators type it either way; the sign must come from the type, not from
    // how the number was keyed in.
    install();
    await save({ financialTransactions: [txn({ type: 'refund', amount: 100 })] });
    expect(rows()[0].signedAmount).toBe(-100);
    expect(rows()[0].amount).toBe(100);
  });

  test.each([
    ['zero', 0],
    ['negative', -50],
    ['non-numeric', 'lots'],
    ['missing', undefined],
  ])('a transaction with a %s amount is dropped', async (_label, amount) => {
    // A zero-value row is noise on a receipt; a negative one would be a refund
    // recorded as a payment.
    install();
    await save({ financialTransactions: [txn({ amount }), txn({ amount: 75 })] });

    expect(rows()).toHaveLength(1);
    expect(rows()[0].amount).toBe(75);
  });

  test('a row that is not an object is dropped rather than stored', async () => {
    install();
    await save({ financialTransactions: [null, 'payment', 42, txn()] });
    expect(rows()).toHaveLength(1);
  });

  test.each([
    ['guarantee_hold', 'guarantee'],
    ['preauth_capture', 'preauth'],
    ['refund', 'refund'],
    ['payment', 'payment'],
  ])('a %s is filed under %s', async (type, category) => {
    install();
    await save({ financialTransactions: [txn({ type })] });
    expect(rows()[0].category).toBe(category);
  });

  test('an explicit category is kept rather than being re-derived', async () => {
    install();
    await save({ financialTransactions: [txn({ type: 'payment', category: 'guarantee' })] });
    expect(rows()[0].category).toBe('guarantee');
  });

  test('every transaction gets an id, even when none was supplied', async () => {
    install();
    await save({ financialTransactions: [txn(), txn({ amount: 50 })] });
    const ids = rows().map((r) => r.id);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  test('a supplied id is preserved', async () => {
    install();
    await save({ financialTransactions: [txn({ id: 'txn-abc' })] });
    expect(rows()[0].id).toBe('txn-abc');
  });

  test('a transaction defaults to posted', async () => {
    install();
    await save({ financialTransactions: [txn()] });
    expect(rows()[0].status).toBe('posted');
  });

  test('the list is capped so one bad client cannot grow the record without limit', async () => {
    install();
    await save({ financialTransactions: Array.from({ length: 500 }, (_, i) => txn({ amount: i + 1 })) });
    expect(rows()).toHaveLength(400);
  });

  test('the booking carries the same transactions as the rental', async () => {
    install();
    await save({ financialTransactions: [txn({ type: 'refund' })] });
    expect(booking().financialTransactions).toEqual(rental().financialTransactions);
  });

  test('a payload with no transactions section leaves the stored list alone', async () => {
    install();
    await save({ financialTransactions: [txn()] });
    await save({ charges: { rental: 100 } });
    expect(rows()).toHaveLength(1);
  });
});

describe('refusals', () => {
  test('reading rentals is not enough to write money', async () => {
    // Without a view-only role in the fixtures, downgrading the gate from Edit
    // to View passes every other test here — the admin used everywhere else
    // holds both.
    install(seed({
      StaffRoles: [{
        _id: 'role-watcher', key: 'watcher', label: 'Watcher', active: true,
        rentalsView: true, specialPermissions: '',
      }],
      StaffUsers: [{ _id: 'user-w', email: STAFF, fullName: 'Watcher', roleKey: 'watcher', active: true }],
    }));
    await expect(saveContract({
      authToken: await token(), bookingId: BOOKING_ID, payload: { charges: { rental: 999 } }, stage: 'checkout',
    })).rejects.toThrow('ACCESS_DENIED');
    expect(fake.rows('RentalsNew')).toHaveLength(0);
  });

  test('an unauthenticated caller is refused', async () => {
    install();
    await expect(saveContract({ bookingId: BOOKING_ID, payload: { charges: { rental: 1 } } }))
      .rejects.toThrow('AUTH_REQUIRED');
  });

  test('a missing booking id is refused', async () => {
    install();
    await expect(saveContract({ authToken: await token(), payload: {} }))
      .resolves.toMatchObject({ success: false, message: 'Missing bookingId' });
  });

  test('an unknown booking is refused without creating a rental', async () => {
    install();
    await expect(saveContract({ authToken: await token(), bookingId: 'nope', payload: {} }))
      .resolves.toMatchObject({ success: false, message: 'Booking not found' });
    expect(fake.rows('RentalsNew')).toHaveLength(0);
  });
});
