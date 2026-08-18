import { bootPageController, createComponent, staffSeed } from '../../../test/helpers/bootPageController.js';
import { derivePasswordHash, randomHex } from '../../backend/staffAccess.jsw';
import { APP_ROUTES } from '../../public/appRoutes.js';

// The rental contract screen — the largest controller on the site, and the one
// with the most to lose. Every field an operator can edit on a rental passes
// through normalizePayload on its way to the backend, so this file is really
// two things: a message router, and a 200-line sanitiser standing between an
// embedded frame and the record that becomes a legal document.
//
// The sanitiser is what the bulk of these tests drive. It is not validation —
// it never refuses anything — but it does decide the *type* of every field, and
// a number arriving as a string, a date as text, or a driver as null is the
// difference between a contract that prints and one that does not.

const COMP = '#contractHtml';
const ADMIN = 'admin@example.com';
const CLERK = 'clerk@example.com';
const PRICER = 'pricer@example.com';
const OUTSIDER = 'pricing@example.com';
const PASSWORD = 'correct-horse-battery';
const TRUSTED = 'https://editor.wix.com';
const URL = 'https://diamond.example/myroom-contract';
const BOOKING_ID = 'bk-1';

function seed() {
  const salt = randomHex(16);
  const cred = (email) => ({
    _id: `cred-${email}`, email, passwordSalt: salt,
    passwordHash: derivePasswordHash(PASSWORD, salt), active: true,
  });
  const base = staffSeed(derivePasswordHash, randomHex, {
    email: ADMIN,
    password: PASSWORD,
    roles: [
      {
        _id: 'role-clerk', key: 'clerk', label: 'Clerk', active: true,
        rentalsView: true, rentalsEdit: true, specialPermissions: '',
      },
      { _id: 'role-pricing', key: 'pricingonly', label: 'Pricing only', active: true, pricingView: true, specialPermissions: '' },
      // Not an admin, but holds two of the three special grants — the only
      // account that can tell the special-permission half of the permission
      // block from the isAdmin half.
      {
        _id: 'role-desk', key: 'desk', label: 'Desk', active: true,
        rentalsView: true, rentalsEdit: true, pricingView: true,
        // Pipe-separated, not comma-separated: parseSpecialPermissions splits on
        // '|', so a comma-separated list reads as one unrecognised grant and
        // silently confers nothing.
        specialPermissions: 'overridePricing|cancelBooking',
      },
    ],
    users: [
      { _id: 'u-clerk', email: CLERK, fullName: 'A Clerk', roleKey: 'clerk', active: true },
      { _id: 'u-3', email: OUTSIDER, fullName: 'An Outsider', roleKey: 'pricingonly', active: true },
      { _id: 'u-desk', email: PRICER, fullName: 'A Desk Agent', roleKey: 'desk', active: true },
    ],
    extraCreds: [cred(CLERK), cred(OUTSIDER), cred(PRICER)],
  });
  return {
    ...base,
    BookingsNew: [{
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
      baseCost: 135, insuranceCost: 36, extrasTotal: 0, ageFee: 0, nightFee: 0, totalPrice: 171,
    }],
    RentalsNew: [],
    FleetNew: [],
    VehiclesNew: [],
    PricingAuditLog: [],
    BusinessSettings: [{ _id: 'bs-1', currency: 'EUR', companyName: 'Diamond Rent A Car' }],
    InsurancePlans: [
      { _id: 'i-1', key: 'cdw', label: 'CDW', pricePerDay: 12, active: true },
      { _id: 'i-2', key: 'retired', label: 'Retired cover', pricePerDay: 5, active: false },
    ],
    ExtraServices: [
      { _id: 'x-1', key: 'gps', label: 'GPS', price: 5, active: true },
      { _id: 'x-2', key: 'old', label: 'Old extra', price: 1, active: false },
    ],
    FeeRules: [
      { _id: 'f-1', key: 'night', label: 'Night', ruleType: 'night', amount: 15, active: true },
      { _id: 'f-2', key: 'stale', label: 'Stale', ruleType: 'night', amount: 1, active: false },
    ],
    PricingSeasons: [],
    CategoryRateRules: [],
    PickupLocations: [
      { _id: 'p-1', key: 'ath', label: 'Athens Airport', address: 'Athens Airport', active: true },
      { _id: 'p-2', key: 'closed', label: 'Closed desk', address: 'Nowhere', active: false },
    ],
  };
}

let ctx;
let html;
let warns;

async function boot({
  signInAs = ADMIN,
  query = { bookingId: BOOKING_ID },
  bare = false,
  component = null,
  extras = {},
  path = ['myroom-contract'],
} = {}) {
  html = component || createComponent(COMP);
  ctx = await bootPageController({
    importer: () => import('../Contract.cysy3.js'),
    components: bare ? {} : { [COMP]: html, ...extras },
    seed: seed(),
    signInAs,
    password: PASSWORD,
    query,
    url: URL,
    path,
  });
  await flush();
  return ctx;
}

const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
const send = (msg, origin = TRUSTED) => html.emitMessage({ origin, data: msg });
const of = (type) => html.postedOfType(type);
const last = (type) => of(type).pop();
const toasts = () => of('toast').map((t) => t.message);
const navigatedTo = () => ctx.wixLocation.to.mock.calls.map((c) => c[0]);
const load = async () => { await send({ type: 'contractReady' }); await flush(); };

/** Captures what normalizePayload handed the backend for one save. */
async function saved(payload, extra = {}) {
  const seen = [];
  const contract = await import('../../backend/rentalContract.jsw');
  const original = contract.saveContract;
  contract.saveContract = (args) => { seen.push(args); return Promise.resolve({ success: true }); };
  try {
    await send({ type: 'saveContract', payload, ...extra });
    await flush();
  } finally {
    contract.saveContract = original;
  }
  return seen[0]?.payload;
}

beforeEach(() => { warns = jest.spyOn(console, 'warn').mockImplementation(() => {}); });

afterEach(async () => {
  if (ctx) await ctx.teardown();
  ctx = null;
  html = null;
  warns.mockRestore();
});

describe('the access guard', () => {
  test('an operator with rentals access gets the screen', async () => {
    await boot();
    await load();

    expect(navigatedTo()).toEqual([]);
    expect(last('loadContractData')).toBeTruthy();
  });

  test('a signed-out visitor is bounced carrying where they were headed', async () => {
    await boot({ signInAs: null });

    expect(navigatedTo()).toEqual([`${APP_ROUTES.home}?next=${encodeURIComponent('/myroom-contract')}`]);
    expect(html.posted).toEqual([]);
  });

  test.each([
    ['a signed-out visitor', null],
    ['an operator with no rentals permission', OUTSIDER],
  ])('%s cannot reach the contract by message either', async (_label, signInAs) => {
    // The redirect comes from requireBackroomAccess itself, so it happens with
    // or without the page's own `if (!authState?.ok) return`. What that line
    // actually buys is that the message handler is never bound — without it a
    // bounced visitor could still drive the whole screen during the moment
    // before the browser follows the redirect.
    await boot({ signInAs });

    await send({ type: 'contractReady' });
    await send({ type: 'setBookingStatus', newStatus: 'Canceled' });
    await send({ type: 'saveContract', payload: { customerName: 'Changed' } });
    await flush();

    expect(html.posted).toEqual([]);
    expect(ctx.fake.rows('BookingsNew')[0].status).toBe('Confirmed');
    expect(ctx.fake.rows('BookingsNew')[0].customerName).toBe('A Customer');
  });

  test('a signed-in operator with no rentals permission is bounced and marked as denied', async () => {
    await boot({ signInAs: OUTSIDER });

    expect(navigatedTo()[0]).toContain('denied=1');
  });

  test('a page with no frame says so, into the void', async () => {
    // post() re-resolves the component before giving up, so the toast is built
    // and dropped rather than skipped — pinned because it means the operator
    // sees nothing at all on a mis-configured page.
    await boot({ bare: true });

    expect(navigatedTo()).toEqual([]);
  });

  test('sibling frames are collapsed and the contract is spared', async () => {
    const stray = createComponent('#legacyHtml');
    await boot({ extras: { '#legacyHtml': stray } });

    expect(stray.collapsed).toBe(1);
    expect(stray.hidden).toBe(1);
    expect(html.collapsed).toBe(0);
  });

  test('a URL with no booking says so on load', async () => {
    await boot({ query: {} });

    expect(toasts()).toEqual(['Missing bookingId in URL.']);
  });
});

describe('reading the URL', () => {
  test.each([
    ['bookingId', { bookingId: BOOKING_ID }],
    ['id', { id: BOOKING_ID }],
  ])('the %s parameter names the booking', async (_label, query) => {
    await boot({ query });
    await load();

    expect(last('loadContractData').booking.bookingNumber).toBe('RNT-2026-0001');
  });

  test('the operator name and return tab travel with the contract', async () => {
    await boot({ query: { bookingId: BOOKING_ID, from: 'fleet' } });
    await load();

    expect(last('loadContractData').context).toMatchObject({
      user: 'A Operator', from: 'fleet', company: 'Diamond Rent A Car', mode: 'ops',
    });
  });

  test('the tab parameter is accepted as an alias for from', async () => {
    await boot({ query: { bookingId: BOOKING_ID, tab: 'bookings' } });
    await load();

    expect(last('loadContractData').context.from).toBe('bookings');
  });

  test.each([
    ['analysis', 'analysis'],
    ['ops', 'ops'],
    ['something-else', 'ops'],
    ['', 'ops'],
  ])('mode=%s resolves to %s', async (mode, expected) => {
    await boot({ query: { bookingId: BOOKING_ID, mode } });
    await load();

    expect(last('loadContractData').context.mode).toBe(expected);
  });

  test('an operator with no name on file is labelled Operator', async () => {
    // buildProfile already defaults fullName, so the page's email fallback is
    // unreachable — the same dead chain the vehicle card carries.
    await boot();
    await load();

    expect(last('loadContractData').context.user).toBe('A Operator');
  });
});

describe('loading the contract', () => {
  test('the booking, the rental draft and the lookups arrive together', async () => {
    await boot();
    await load();

    const payload = last('loadContractData');
    expect(payload.booking).toMatchObject({ bookingNumber: 'RNT-2026-0001', customerName: 'A Customer' });
    expect(payload.rental.financials).toEqual({
      paymentMethod: 'cash', paymentStatus: 'pending', collectionMode: 'pay_arrival',
      prepaid: 0, paidNow: 0, deposit: 0,
    });
    // A booking with no rental record yet still arrives with its charge lines
    // derived from the booking's stored totals, so the frame has something to
    // render before anything has been saved.
    expect(payload.rental.chargeLines.map((l) => l.code)).toContain('rental_base');
    expect(payload.rental.chargeLines.find((l) => l.code === 'rental_base')).toMatchObject({
      amount: 135, derived: true,
    });
    expect(payload.rental.financialTransactions).toEqual([]);
  });

  test('only the active catalogue rows are offered to the operator', async () => {
    // An inactive plan is one the site has stopped selling; offering it on a new
    // contract would put a withdrawn price on a signed document.
    //
    // Mutation note: the page filters `active !== false` on all four lists, and
    // deleting any of those filters changes nothing — every read inside
    // pricingCatalog already applies the same filter, at every scope. Four
    // equivalent mutants, and a duplicated rule worth knowing about.
    await boot();
    await load();

    const { lookups } = last('loadContractData');
    expect(lookups.insurancePlans.map((r) => r.key)).toEqual(['cdw']);
    expect(lookups.extraServices.map((r) => r.key)).toEqual(['gps']);
    expect(lookups.feeRules.map((r) => r.key)).toEqual(['night']);
    expect(lookups.pickupLocations.map((r) => r.key)).toEqual(['ath']);
  });

  test('the operator’s special permissions travel with the contract', async () => {
    await boot();
    await load();

    expect(last('loadContractData').context.permissions).toEqual({
      isAdmin: true, canOverridePricing: true, canApproveManualOverride: true, canCancelBooking: true,
    });
  });

  test('a non-admin gets exactly the special grants their role names', async () => {
    // The half of the permission block that is not simply isAdmin: this account
    // may override a price and cancel a booking, but may not approve an
    // override — and is not an admin.
    await boot({ signInAs: PRICER });
    await load();

    expect(last('loadContractData').context.permissions).toEqual({
      isAdmin: false,
      canOverridePricing: true,
      canApproveManualOverride: false,
      canCancelBooking: true,
    });
  });

  test('a clerk gets none of the special permissions', async () => {
    await boot({ signInAs: CLERK });
    await load();

    expect(last('loadContractData').context.permissions).toEqual({
      isAdmin: false, canOverridePricing: false, canApproveManualOverride: false, canCancelBooking: false,
    });
  });

  test('a failing pricing catalogue empties the lookups rather than failing the load', async () => {
    await boot();
    const admin = await import('../../backend/pricingAdmin.jsw');
    const original = admin.getStaffPricingCatalog;
    admin.getStaffPricingCatalog = () => Promise.reject(new Error('catalogue offline'));
    try {
      await load();
    } finally {
      admin.getStaffPricingCatalog = original;
    }

    const payload = last('loadContractData');
    expect(payload.booking.bookingNumber).toBe('RNT-2026-0001');
    expect(payload.lookups.insurancePlans).toEqual([]);
    expect(payload.context.company).toBe('Diamond Rent A Car');
  });

  test('a backend that reports failure surfaces its reason', async () => {
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.getContract;
    contract.getContract = () => Promise.resolve({ success: false, message: 'Booking not found' });
    try {
      await load();
    } finally {
      contract.getContract = original;
    }

    expect(toasts()).toContain('Booking not found');
    expect(of('loadContractData')).toEqual([]);
  });

  test('a backend that reports failure without a reason still says something', async () => {
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.getContract;
    contract.getContract = () => Promise.resolve({ success: false });
    try {
      await load();
    } finally {
      contract.getContract = original;
    }

    expect(toasts()).toContain('Failed to load contract.');
  });

  test('a backend that throws surfaces the error', async () => {
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.getContract;
    contract.getContract = () => Promise.reject(new Error('database down'));
    try {
      await load();
    } finally {
      contract.getContract = original;
    }

    expect(toasts()).toContain('database down');
  });

  test('a load with no booking in the URL says so', async () => {
    await boot({ query: {} });

    await load();

    expect(toasts()).toContain('Cannot load contract: missing bookingId.');
  });

  test('reloadContract loads it again', async () => {
    await boot();
    await load();

    await send({ type: 'reloadContract' });
    await flush();

    expect(of('loadContractData')).toHaveLength(2);
  });
});

describe('saving the contract', () => {
  test('a save is written and confirmed with the time of day', async () => {
    await boot();
    await load();

    await send({ type: 'saveContract', payload: { customerName: 'A New Name' } });
    await flush();

    expect(last('saveState')).toMatchObject({ message: 'Saved ✅', at: expect.stringMatching(/^\d{2}:\d{2}$/) });
    // Reloaded afterwards, so the frame shows the stored record rather than the
    // draft it just sent.
    expect(of('loadContractData')).toHaveLength(2);
  });

  test('the confirmation time is zero-padded, so 09:05 does not read as 9:5', async () => {
    await boot();
    await load();
    jest.setSystemTime(new Date('2026-03-10T09:05:00.000Z'));

    await send({ type: 'saveContract', payload: {} });
    await flush();

    expect(last('saveState').at).toMatch(/^\d{2}:\d{2}$/);
    expect(last('saveState').at.endsWith(':05')).toBe(true);
  });

  test('a warning from the backend replaces the confirmation', async () => {
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.saveContract;
    contract.saveContract = () => Promise.resolve({ success: true, warning: 'Prices differ from the snapshot' });
    try {
      await load();
      await send({ type: 'saveContract', payload: {} });
      await flush();
    } finally {
      contract.saveContract = original;
    }

    expect(last('saveState').message).toBe('Prices differ from the snapshot');
  });

  test('a refused save surfaces its reason and does not reload', async () => {
    await boot();
    await load();
    const before = of('loadContractData').length;
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.saveContract;
    contract.saveContract = () => Promise.resolve({ success: false, message: 'Needs approval' });
    try {
      await send({ type: 'saveContract', payload: {} });
      await flush();
    } finally {
      contract.saveContract = original;
    }

    expect(toasts()).toContain('Needs approval');
    expect(of('loadContractData')).toHaveLength(before);
    expect(of('saveState')).toEqual([]);
  });

  test('a refused save with no reason still says something', async () => {
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.saveContract;
    contract.saveContract = () => Promise.resolve({ success: false });
    try {
      await load();
      await send({ type: 'saveContract', payload: {} });
      await flush();
    } finally {
      contract.saveContract = original;
    }

    expect(toasts()).toContain('Save failed.');
  });

  test('a save that throws surfaces the error', async () => {
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.saveContract;
    contract.saveContract = () => Promise.reject(new Error('database down'));
    try {
      await load();
      await send({ type: 'saveContract', payload: {} });
      await flush();
    } finally {
      contract.saveContract = original;
    }

    expect(toasts()).toContain('database down');
  });

  test('a save with no booking anywhere says so', async () => {
    await boot({ query: {} });

    await send({ type: 'saveContract', payload: {} });
    await flush();

    expect(toasts()).toContain('Cannot save: missing bookingId.');
  });

  test('a booking named in the message overrides the one in the URL', async () => {
    const seen = [];
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.saveContract;
    contract.saveContract = (args) => { seen.push(args); return Promise.resolve({ success: true }); };
    try {
      await load();
      await send({ type: 'saveContract', bookingId: 'bk-other', payload: {} });
      await flush();
    } finally {
      contract.saveContract = original;
    }

    expect(seen[0].bookingId).toBe('bk-other');
  });

  test('the stage travels with the save', async () => {
    const seen = [];
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.saveContract;
    contract.saveContract = (args) => { seen.push(args); return Promise.resolve({ success: true }); };
    try {
      await load();
      await send({ type: 'saveContract', payload: {}, stage: 'checkout' });
      await flush();
    } finally {
      contract.saveContract = original;
    }

    expect(seen[0].stage).toBe('checkout');
  });

  test('the save is authorised by the operator’s session, not by the message', async () => {
    const seen = [];
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.saveContract;
    contract.saveContract = (args) => { seen.push(args); return Promise.resolve({ success: true }); };
    try {
      await load();
      await send({ type: 'saveContract', payload: {}, authToken: 'forged' });
      await flush();
    } finally {
      contract.saveContract = original;
    }

    expect(seen[0].authToken).not.toBe('forged');
    expect(seen[0].authToken).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('what the sanitiser does to a draft', () => {
  beforeEach(async () => {
    await boot();
    await load();
  });

  test('text fields are coerced and trimmed, and nullish ones become empty strings', async () => {
    const payload = await saved({
      customerName: '  A Customer  ', phone: 2101234567, email: null,
      flightNumber: undefined, internalMemo: '  note  ',
    });

    expect(payload).toMatchObject({
      customerName: 'A Customer', phone: '2101234567', email: '',
      flightNumber: '', internalMemo: 'note',
    });
  });

  test('numeric fields are coerced, and unparseable ones fall back to zero', async () => {
    const payload = await saved({
      checkoutOdometer: '41200', checkinOdometer: 'not a number',
      checkoutFuelLevel: 8.5, checkinFuelLevel: null,
    });

    expect(payload).toMatchObject({
      checkoutOdometer: 41200, checkinOdometer: 0, checkoutFuelLevel: 8.5, checkinFuelLevel: 0,
    });
  });

  test('the two dates become Date objects, and are omitted when absent', async () => {
    const withDates = await saved({ pickupDateTime: '2026-03-10T08:00:00.000Z' });
    const withoutDates = await saved({});

    expect(withDates.pickupDateTime).toBeInstanceOf(Date);
    expect(withDates.pickupDateTime.toISOString()).toBe('2026-03-10T08:00:00.000Z');
    expect(withDates).not.toHaveProperty('dropoffDateTime');
    expect(withoutDates).not.toHaveProperty('pickupDateTime');
  });

  test('every charge bucket is present and numeric even when the frame sends none', async () => {
    const payload = await saved({});

    expect(payload.charges).toEqual({
      rental: 0, insurance: 0, options: 0, ageFee: 0, nightFee: 0,
      transport: 0, damages: 0, surcharges: 0, discount: 0,
    });
  });

  test('a charge bucket sent as a string is coerced', async () => {
    const payload = await saved({ charges: { rental: '135.50', damages: 'nope' } });

    expect(payload.charges).toMatchObject({ rental: 135.5, damages: 0 });
  });

  test('a charge line carries its own sign and absolute amount', async () => {
    const payload = await saved({
      chargeLines: [
        { id: 'l1', label: 'Rental', amount: 135, code: 'RENT' },
        { id: 'l2', label: 'Discount', amount: -20 },
      ],
    });

    expect(payload.chargeLines).toEqual([
      expect.objectContaining({ id: 'l1', label: 'Rental', amount: 135, absAmount: 135, sign: 1, editable: true, taxable: true }),
      expect.objectContaining({ id: 'l2', amount: -20, absAmount: 20, sign: -1 }),
    ]);
  });

  test('a charge line accepts its amount under three names', async () => {
    const payload = await saved({
      chargeLines: [{ value: 40 }, { absAmount: 25 }, { amount: 10, value: 999 }],
    });

    expect(payload.chargeLines.map((l) => l.amount)).toEqual([40, 25, 10]);
  });

  test('an explicit sign is kept over the one implied by the amount', async () => {
    const payload = await saved({ chargeLines: [{ amount: 30, sign: -1 }] });

    expect(payload.chargeLines[0]).toMatchObject({ amount: 30, absAmount: 30, sign: -1 });
  });

  test('a charge line can be marked derived, locked or untaxed', async () => {
    const payload = await saved({
      chargeLines: [{ amount: 1, derived: true, editable: false, taxable: false }],
    });

    expect(payload.chargeLines[0]).toMatchObject({ derived: true, editable: false, taxable: false });
  });

  test('entries that are not objects are dropped from the lists rather than kept as nulls', async () => {
    const payload = await saved({
      chargeLines: [null, 'a string', { amount: 5 }],
      financialTransactions: [null, 42, { amount: 10 }],
      additionalDrivers: [null, { fullName: 'A Driver' }, 'nope'],
    });

    expect(payload.chargeLines).toHaveLength(1);
    expect(payload.financialTransactions).toHaveLength(1);
    expect(payload.additionalDrivers).toHaveLength(1);
  });

  test('a list sent as something other than a list becomes an empty one', async () => {
    const payload = await saved({
      chargeLines: 'not a list', financialTransactions: {}, additionalDrivers: 7, selectedExtras: 'gps',
    });

    expect(payload.chargeLines).toEqual([]);
    expect(payload.financialTransactions).toEqual([]);
    expect(payload.additionalDrivers).toEqual([]);
    expect(payload.selectedExtras).toEqual([]);
  });

  test('a financial transaction keeps its money, its time and a posted default', async () => {
    const payload = await saved({
      financialTransactions: [{
        id: 'tx1', type: 'payment', amount: '50', signedAmount: -50,
        at: '2026-03-10T09:00:00.000Z', method: 'card', user: '  Desk  ',
      }],
    });

    expect(payload.financialTransactions[0]).toMatchObject({
      id: 'tx1', type: 'payment', amount: 50, signedAmount: -50,
      method: 'card', user: 'Desk', status: 'posted',
    });
    expect(payload.financialTransactions[0].at).toBeInstanceOf(Date);
  });

  test('a transaction with no timestamp gets null rather than an invalid date', async () => {
    const payload = await saved({ financialTransactions: [{ amount: 1 }] });

    expect(payload.financialTransactions[0].at).toBeNull();
  });

  test('a transaction can override the posted status', async () => {
    const payload = await saved({ financialTransactions: [{ amount: 1, status: 'void' }] });

    expect(payload.financialTransactions[0].status).toBe('void');
  });

  test('a driver is reduced to the fields the contract prints', async () => {
    const payload = await saved({
      mainDriver: {
        fullName: '  A Driver  ', licenseNo: 'DL-1', licenseExpiry: '2030-01-01',
        idNo: 'ID-1', dob: '1990-01-01', address: 'Somewhere', notes: '  none  ',
        secretInternalScore: 99,
      },
    });

    expect(payload.mainDriver).toEqual({
      fullName: 'A Driver', phone: '', email: '', licenseNo: 'DL-1', licenseCountry: '',
      licenseExpiry: '2030-01-01', idNo: 'ID-1', idCountry: '', dob: '1990-01-01',
      address: 'Somewhere', notes: 'none',
    });
    // Anything the frame invents is dropped rather than written through.
    expect(payload.mainDriver).not.toHaveProperty('secretInternalScore');
  });

  test('a missing main driver becomes null rather than an empty shell', async () => {
    const payload = await saved({});

    expect(payload.mainDriver).toBeNull();
  });

  test('billing defaults to Greek VAT, inclusive', async () => {
    const payload = await saved({});

    expect(payload.billing).toMatchObject({ vatRate: 0.24, vatInclusive: true });
  });

  test('billing accepts an explicit rate and an exclusive flag', async () => {
    const payload = await saved({ billing: { vatRate: 0.13, vatInclusive: false, vatNumber: '  EL123  ' } });

    expect(payload.billing).toMatchObject({ vatRate: 0.13, vatInclusive: false, vatNumber: 'EL123' });
  });

  test('an unparseable VAT rate falls back to the Greek one rather than to zero', async () => {
    const payload = await saved({ billing: { vatRate: 'twenty four percent' } });

    expect(payload.billing.vatRate).toBe(0.24);
  });

  test('a guardrail override without a reason is dropped entirely', async () => {
    const withReason = await saved({ checkoutGuardrailOverride: { reason: '  Manager approved  ', actor: 'A Manager' } });
    const withoutReason = await saved({ checkoutGuardrailOverride: { actor: 'A Manager' } });
    const notAnObject = await saved({ checkoutGuardrailOverride: 'yes please' });

    // An override is a written justification for skipping a check; without one
    // there is nothing to record, so no override is claimed.
    expect(withReason.checkoutGuardrailOverride).toEqual({
      reason: 'Manager approved', actor: 'A Manager', updatedAt: '',
    });
    expect(withoutReason.checkoutGuardrailOverride).toBeNull();
    expect(notAnObject.checkoutGuardrailOverride).toBeNull();
  });

  test('an override reason can arrive under either name', async () => {
    const payload = await saved({ checkoutGuardrailOverride: { note: 'Manager approved', user: 'A Manager', at: '2026-03-10' } });

    expect(payload.checkoutGuardrailOverride).toEqual({
      reason: 'Manager approved', actor: 'A Manager', updatedAt: '2026-03-10',
    });
  });

  test.each([
    ['not_started', 'not_started'],
    ['pending', 'pending'],
    ['captured', 'captured'],
    ['waived', 'waived'],
    ['CAPTURED', 'captured'],
    ['forged', 'not_started'],
    ['', 'not_started'],
  ])('a signature status of %s is stored as %s', async (status, expected) => {
    const payload = await saved({ signatureState: { status } });

    expect(payload.signatureState.status).toBe(expected);
  });

  test('a signature state that is not an object is dropped', async () => {
    const payload = await saved({ signatureState: 'signed, honest' });

    expect(payload.signatureState).toBeNull();
  });

  test('a signature state defaults to not_started and accepts either field name', async () => {
    const payload = await saved({ signatureState: { state: 'pending', customerName: 'A Customer', at: '2026-03-10', reason: 'why' } });

    expect(payload.signatureState).toMatchObject({
      status: 'pending', signerName: 'A Customer', signedAt: '2026-03-10', note: 'why',
    });
  });

  test('the commercial state is coerced to text and numbers', async () => {
    const payload = await saved({ commercialState: { paymentStatus: 'paid', outstanding: '12.5', paidTotal: 'nope' } });

    expect(payload.commercialState).toEqual({
      paymentStatus: 'paid', settlementState: '', outstanding: 12.5, paidTotal: 0, notes: '',
    });
  });

  test('the companion financials block is always present with its defaults', async () => {
    const payload = await saved({});

    expect(payload.financials).toEqual({
      paymentMethod: 'cash', paymentStatus: 'pending', collectionMode: 'pay_arrival',
      prepaid: 0, paidNow: 0, deposit: 0,
    });
  });

  test('the financials block takes what the frame sends', async () => {
    const payload = await saved({
      financials: { paymentMethod: 'card', paymentStatus: 'paid', collectionMode: 'prepaid', prepaid: '100', deposit: 300 },
    });

    expect(payload.financials).toEqual({
      paymentMethod: 'card', paymentStatus: 'paid', collectionMode: 'prepaid',
      prepaid: 100, paidNow: 0, deposit: 300,
    });
  });

  test('fields the sanitiser does not name are passed through untouched', async () => {
    // The spread comes first, so an unrecognised key survives — which is how new
    // frame fields reach the backend before this list learns about them.
    const payload = await saved({ someFutureField: { nested: true } });

    expect(payload.someFutureField).toEqual({ nested: true });
  });

  test('a payload that is not an object at all is treated as an empty draft', async () => {
    const payload = await saved('not a payload');

    expect(payload).toMatchObject({ customerName: '', charges: expect.any(Object) });
  });

  test('photos are passed through as they arrive', async () => {
    const payload = await saved({ photos: ['a.jpg', 'b.jpg'] });

    expect(payload.photos).toEqual(['a.jpg', 'b.jpg']);
  });
});

describe('the rental draft the frame is handed back', () => {
  test('a stored rental keeps its own financials rather than being reset', async () => {
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.getContract;
    contract.getContract = () => Promise.resolve({
      success: true,
      booking: {},
      rental: { financials: { paymentMethod: 'card', prepaid: 100 }, chargeLines: [{ id: 'l1' }] },
    });
    try {
      await load();
    } finally {
      contract.getContract = original;
    }

    expect(last('loadContractData').rental.financials).toMatchObject({ paymentMethod: 'card', prepaid: 100 });
    expect(last('loadContractData').rental.chargeLines).toHaveLength(1);
  });

  test('legacy flat fields are lifted into the financials block', async () => {
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.getContract;
    contract.getContract = () => Promise.resolve({
      success: true, booking: {},
      rental: { paymentMethod: 'card', prepaidAmount: 50, paidNowAmount: 25, depositAmount: 300 },
    });
    try {
      await load();
    } finally {
      contract.getContract = original;
    }

    expect(last('loadContractData').rental.financials).toEqual({
      paymentMethod: 'card', paymentStatus: 'pending', collectionMode: 'pay_arrival',
      prepaid: 50, paidNow: 25, deposit: 300,
    });
  });

  test('a rental that is not an object becomes an empty draft', async () => {
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.getContract;
    contract.getContract = () => Promise.resolve({ success: true, booking: {}, rental: 'nope' });
    try {
      await load();
    } finally {
      contract.getContract = original;
    }

    expect(last('loadContractData').rental).toMatchObject({
      financials: expect.any(Object), chargeLines: [], financialTransactions: [],
    });
  });
});

describe('customer and company insights', () => {
  test.each([
    ['fetchCustomerInsights', 'customerInsightsData', 'getCustomerInsights'],
    ['fetchCompanyInsights', 'companyInsightsData', 'getCompanyInsights'],
  ])('%s answers on %s', async (request, reply, fn) => {
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract[fn];
    contract[fn] = () => Promise.resolve({
      success: true, profile: { name: 'A Customer' }, summary: { rentals: 3 }, history: [{ id: 'h1' }],
    });
    try {
      await load();
      await send({ type: request, requestId: 'req-1', payload: { email: 'customer@example.com' } });
      await flush();
    } finally {
      contract[fn] = original;
    }

    expect(last(reply)).toEqual({
      type: reply, requestId: 'req-1',
      data: { profile: { name: 'A Customer' }, summary: { rentals: 3 }, history: [{ id: 'h1' }] },
      message: '',
    });
  });

  test.each([
    ['fetchCustomerInsights', 'customerInsightsData', 'getCustomerInsights'],
    ['fetchCompanyInsights', 'companyInsightsData', 'getCompanyInsights'],
  ])('%s reports a refusal as null data with the reason', async (request, reply, fn) => {
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract[fn];
    contract[fn] = () => Promise.resolve({ success: false, message: 'Not enough history' });
    try {
      await load();
      await send({ type: request, requestId: 'req-2' });
      await flush();
    } finally {
      contract[fn] = original;
    }

    expect(last(reply)).toMatchObject({ requestId: 'req-2', data: null, message: 'Not enough history' });
  });

  test.each([
    ['fetchCustomerInsights', 'customerInsightsData', 'getCustomerInsights'],
    ['fetchCompanyInsights', 'companyInsightsData', 'getCompanyInsights'],
  ])('%s reports a throw as null data with the error', async (request, reply, fn) => {
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract[fn];
    contract[fn] = () => Promise.reject(new Error('insights offline'));
    try {
      await load();
      await send({ type: request, requestId: 'req-3' });
      await flush();
    } finally {
      contract[fn] = original;
    }

    expect(last(reply)).toEqual({
      type: reply, requestId: 'req-3', data: null, message: 'insights offline',
    });
  });

  test('the request id is echoed so the frame can match the answer to its question', async () => {
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.getCustomerInsights;
    contract.getCustomerInsights = () => Promise.resolve({ success: true });
    try {
      await load();
      await send({ type: 'fetchCustomerInsights' });
      await flush();
    } finally {
      contract.getCustomerInsights = original;
    }

    expect(last('customerInsightsData').requestId).toBe('');
  });

  test('the lookup is capped so a long history cannot stall the panel', async () => {
    const seen = [];
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.getCustomerInsights;
    contract.getCustomerInsights = (args) => { seen.push(args); return Promise.resolve({ success: true }); };
    try {
      await load();
      await send({ type: 'fetchCustomerInsights', payload: { email: 'a@example.com' } });
      await flush();
    } finally {
      contract.getCustomerInsights = original;
    }

    expect(seen[0]).toMatchObject({ limit: 80, customer: { email: 'a@example.com' } });
  });
});

describe('the document actions', () => {
  const stub = async (fn, value) => {
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract[fn];
    contract[fn] = () => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
    return () => { contract[fn] = original; };
  };

  test('capabilities are reported back with whatever the renderer knows', async () => {
    await boot();
    const restore = await stub('getContractDocumentRenderCapabilities', {
      success: true, capabilities: { pdf: true, browser: false },
    });
    try {
      await load();
      await send({ type: 'documentAction', action: 'capabilities', requestId: 'r1' });
      await flush();
    } finally { restore(); }

    expect(last('documentActionResult')).toEqual({
      type: 'documentActionResult', requestId: 'r1', success: true,
      action: 'capabilities', capabilities: { pdf: true, browser: false }, message: '',
    });
  });

  test('a pdf request relays the document and how it was rendered', async () => {
    await boot();
    const restore = await stub('exportContractPdfFromHtml', {
      success: true, filename: 'contract.pdf', pdfBase64: 'JVBERi0=',
      renderEngine: 'puppeteer', fidelity: 'high', fallbackUsed: false,
      capabilitySnapshot: { browser: true },
    });
    try {
      await load();
      await send({ type: 'documentAction', action: 'pdf', documentType: 'AGREEMENT', requestId: 'r2' });
      await flush();
    } finally { restore(); }

    expect(last('documentActionResult')).toMatchObject({
      requestId: 'r2', success: true, action: 'pdf',
      // Lower-cased on the way in, so the frame's casing cannot miss the backend.
      documentType: 'agreement',
      filename: 'contract.pdf', pdfBase64: 'JVBERi0=', renderEngine: 'puppeteer',
      fidelity: 'high', fallbackUsed: false, capabilities: { browser: true },
    });
  });

  test('a fallback render says so, and why', async () => {
    await boot();
    const restore = await stub('exportContractPdfFromHtml', {
      success: true, fallbackUsed: true, fallbackReason: 'browser unavailable', fidelity: 'basic',
    });
    try {
      await load();
      await send({ type: 'documentAction', action: 'pdf' });
      await flush();
    } finally { restore(); }

    expect(last('documentActionResult')).toMatchObject({
      fallbackUsed: true, fallbackReason: 'browser unavailable', fidelity: 'basic',
    });
  });

  test.each([
    ['preview', 'preview'],
    ['', 'preview'],
    ['anything-else', 'preview'],
  ])('an action of %s renders the document', async (action, expected) => {
    await boot();
    const restore = await stub('exportContractRenderedDocument', {
      success: true, html: '<h1>Contract</h1>', package: { pages: 2 }, printable: { css: 'a4' },
    });
    try {
      await load();
      await send({ type: 'documentAction', action, requestId: 'r3' });
      await flush();
    } finally { restore(); }

    expect(last('documentActionResult')).toMatchObject({
      requestId: 'r3', success: true, action: expected,
      documentType: 'agreement', html: '<h1>Contract</h1>',
      package: { pages: 2 }, printable: { css: 'a4' },
    });
  });

  test('the document type defaults to the agreement', async () => {
    const seen = [];
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.exportContractRenderedDocument;
    contract.exportContractRenderedDocument = (args) => { seen.push(args); return Promise.resolve({ success: true }); };
    try {
      await load();
      await send({ type: 'documentAction' });
      await flush();
    } finally {
      contract.exportContractRenderedDocument = original;
    }

    expect(seen[0]).toMatchObject({ documentType: 'agreement', bookingId: BOOKING_ID });
  });

  test('a document request with no booking anywhere is refused with its request id intact', async () => {
    await boot({ query: {} });

    await send({ type: 'documentAction', requestId: 'r4' });
    await flush();

    expect(last('documentActionResult')).toEqual({
      type: 'documentActionResult', requestId: 'r4', success: false, message: 'Missing bookingId.',
    });
  });

  test('a renderer that throws is reported against the action that was asked for', async () => {
    await boot();
    const restore = await stub('exportContractPdfFromHtml', new Error('renderer offline'));
    try {
      await load();
      await send({ type: 'documentAction', action: 'pdf', requestId: 'r5' });
      await flush();
    } finally { restore(); }

    expect(last('documentActionResult')).toEqual({
      type: 'documentActionResult', requestId: 'r5', success: false,
      action: 'pdf', message: 'renderer offline',
    });
  });

  test('a refused render is relayed as a failure with its reason', async () => {
    await boot();
    const restore = await stub('exportContractRenderedDocument', { success: false, message: 'Template missing' });
    try {
      await load();
      await send({ type: 'documentAction', action: 'preview' });
      await flush();
    } finally { restore(); }

    expect(last('documentActionResult')).toMatchObject({ success: false, message: 'Template missing' });
  });
});

describe('confirming and changing status', () => {
  test('a confirmation is applied and the contract reloaded', async () => {
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.confirmBookingAnalysis;
    contract.confirmBookingAnalysis = () => Promise.resolve({ success: true, message: 'Booking confirmed' });
    try {
      await load();
      await send({ type: 'confirmBooking' });
      await flush();
    } finally {
      contract.confirmBookingAnalysis = original;
    }

    expect(last('saveState').message).toBe('Booking confirmed');
    expect(of('loadContractData')).toHaveLength(2);
  });

  test('a confirmation with no message still says something', async () => {
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.confirmBookingAnalysis;
    contract.confirmBookingAnalysis = () => Promise.resolve({ success: true });
    try {
      await load();
      await send({ type: 'confirmBooking' });
      await flush();
    } finally {
      contract.confirmBookingAnalysis = original;
    }

    expect(last('saveState').message).toBe('Booking confirmed');
  });

  test('a refused confirmation surfaces its reason and does not reload', async () => {
    await boot();
    await load();
    const before = of('loadContractData').length;
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.confirmBookingAnalysis;
    contract.confirmBookingAnalysis = () => Promise.resolve({ success: false, message: 'Already confirmed' });
    try {
      await send({ type: 'confirmBooking' });
      await flush();
    } finally {
      contract.confirmBookingAnalysis = original;
    }

    expect(toasts()).toContain('Already confirmed');
    expect(of('loadContractData')).toHaveLength(before);
  });

  test('a confirmation that throws surfaces the error', async () => {
    await boot();
    const contract = await import('../../backend/rentalContract.jsw');
    const original = contract.confirmBookingAnalysis;
    contract.confirmBookingAnalysis = () => Promise.reject(new Error('database down'));
    try {
      await load();
      await send({ type: 'confirmBooking' });
      await flush();
    } finally {
      contract.confirmBookingAnalysis = original;
    }

    expect(toasts()).toContain('database down');
  });

  test('a confirmation with no booking says so', async () => {
    await boot({ query: {} });

    await send({ type: 'confirmBooking' });
    await flush();

    expect(toasts()).toContain('Cannot confirm: missing bookingId.');
  });

  test('a status change is written and the contract reloaded', async () => {
    await boot();
    await load();

    await send({ type: 'setBookingStatus', newStatus: 'Hold' });
    await flush();

    expect(ctx.fake.rows('BookingsNew')[0].status).toBe('Hold');
    expect(last('saveState').message).toBeTruthy();
    expect(of('loadContractData')).toHaveLength(2);
  });

  test('a status change with no status at all does nothing', async () => {
    await boot();
    await load();
    const before = html.posted.length;

    await send({ type: 'setBookingStatus' });
    await send({ type: 'setBookingStatus', newStatus: '   ' });
    await flush();

    expect(html.posted.length).toBe(before);
    expect(ctx.fake.rows('BookingsNew')[0].status).toBe('Confirmed');
  });

  test('a refused status change surfaces its reason', async () => {
    await boot();
    const board = await import('../../backend/bookingsBoard.jsw');
    const original = board.setBookingBoardStatus;
    board.setBookingBoardStatus = () => Promise.resolve({ success: false, message: 'Not allowed' });
    try {
      await load();
      await send({ type: 'setBookingStatus', newStatus: 'Hold' });
      await flush();
    } finally {
      board.setBookingBoardStatus = original;
    }

    expect(toasts()).toContain('Not allowed');
  });

  test('a status change with no message names the status it applied', async () => {
    await boot();
    const board = await import('../../backend/bookingsBoard.jsw');
    const original = board.setBookingBoardStatus;
    board.setBookingBoardStatus = () => Promise.resolve({ success: true });
    try {
      await load();
      await send({ type: 'setBookingStatus', newStatus: 'Hold' });
      await flush();
    } finally {
      board.setBookingBoardStatus = original;
    }

    expect(last('saveState').message).toBe('Status: Hold');
  });

  test('a status change that throws surfaces the error', async () => {
    await boot();
    const board = await import('../../backend/bookingsBoard.jsw');
    const original = board.setBookingBoardStatus;
    board.setBookingBoardStatus = () => Promise.reject(new Error('database down'));
    try {
      await load();
      await send({ type: 'setBookingStatus', newStatus: 'Hold' });
      await flush();
    } finally {
      board.setBookingBoardStatus = original;
    }

    expect(toasts()).toContain('database down');
  });

  test('a status change with no booking says so', async () => {
    await boot({ query: {} });

    await send({ type: 'setBookingStatus', newStatus: 'Hold' });
    await flush();

    expect(toasts()).toContain('Cannot update status: missing bookingId.');
  });
});

describe('navigating away', () => {
  const FULL_QUERY = {
    bookingId: BOOKING_ID, from: 'fleet',
    date: '2026-03-10', startDate: '2026-03-01', endDate: '2026-03-31',
  };

  test('openOnBookings carries the booking and the range it arrived with', async () => {
    await boot({ query: FULL_QUERY });

    await send({ type: 'openOnBookings' });

    expect(navigatedTo()).toEqual([
      `${APP_ROUTES.bookings}?bookingId=${BOOKING_ID}&startDate=2026-03-01&endDate=2026-03-31`,
    ]);
  });

  test('openOnBookings prefers the dates in the message', async () => {
    await boot({ query: FULL_QUERY });

    await send({ type: 'openOnBookings', bookingId: 'bk-other', startDate: '2026-05-01', endDate: '2026-05-31' });

    expect(navigatedTo()[0]).toContain('bookingId=bk-other&startDate=2026-05-01&endDate=2026-05-31');
  });

  test('openOnBookings ignores a malformed date in the message', async () => {
    await boot({ query: FULL_QUERY });

    await send({ type: 'openOnBookings', startDate: '01/05/2026' });

    expect(navigatedTo()[0]).toContain('startDate=2026-03-01');
  });

  test('openOnFleet marks where it came from', async () => {
    await boot({ query: FULL_QUERY });

    await send({ type: 'openOnFleet' });

    expect(navigatedTo()).toEqual([
      `${APP_ROUTES.fleet}?bookingId=${BOOKING_ID}&startDate=2026-03-01&endDate=2026-03-31&from=contract`,
    ]);
  });

  test('openOnDaily carries the day', async () => {
    await boot({ query: FULL_QUERY });

    await send({ type: 'openOnDaily' });

    expect(navigatedTo()).toEqual([`${APP_ROUTES.daily}?bookingId=${BOOKING_ID}&date=2026-03-10`]);
  });

  test('openOnDaily prefers the date in the message', async () => {
    await boot({ query: FULL_QUERY });

    await send({ type: 'openOnDaily', date: '2026-04-01' });

    expect(navigatedTo()[0]).toContain('date=2026-04-01');
  });

  test('a deep link with nothing to carry still goes somewhere', async () => {
    await boot({ query: {} });

    await send({ type: 'openOnDaily' });

    expect(navigatedTo()).toEqual([`${APP_ROUTES.daily}?`]);
  });

  test('openBookingContract reopens this same page for another booking', async () => {
    await boot({ query: FULL_QUERY });

    await send({ type: 'openBookingContract', bookingId: 'bk-other' });

    expect(navigatedTo()).toEqual([
      '/myroom-contract?from=fleet&mode=ops&date=2026-03-10&startDate=2026-03-01&endDate=2026-03-31&bookingId=bk-other',
    ]);
  });

  test('openBookingContract keeps the analysis mode it was opened in', async () => {
    await boot({ query: { bookingId: BOOKING_ID, mode: 'analysis' } });

    await send({ type: 'openBookingContract', bookingId: 'bk-other' });

    expect(navigatedTo()[0]).toContain('mode=analysis');
  });

  test('openBookingContract falls back to /contract when the path is empty', async () => {
    await boot({ path: [] });

    await send({ type: 'openBookingContract', bookingId: 'bk-other' });

    expect(navigatedTo()[0]).toMatch(/^\/contract\?/);
  });

  test('openBookingContract with no booking goes nowhere', async () => {
    await boot();

    await send({ type: 'openBookingContract' });
    await send({ type: 'openBookingContract', bookingId: '   ' });

    expect(navigatedTo()).toEqual([]);
  });

  test('openVehicleCard opens the card, encoding the id', async () => {
    await boot();

    await send({ type: 'openVehicleCard', fleetVehicleId: 'DRC 001&x' });

    expect(navigatedTo()).toEqual([`${APP_ROUTES.vehiclecard}?fleetVehicleId=DRC%20001%26x`]);
  });

  test('openVehicleCard accepts the vehicleId spelling', async () => {
    await boot();

    await send({ type: 'openVehicleCard', vehicleId: 'DRC-002' });

    expect(navigatedTo()[0]).toContain('fleetVehicleId=DRC-002');
  });

  test('openVehicleCard with no vehicle goes nowhere', async () => {
    await boot();

    await send({ type: 'openVehicleCard' });
    await send({ type: 'openVehicleCard', fleetVehicleId: '  ' });

    expect(navigatedTo()).toEqual([]);
  });

  test('back returns to the tab the operator came from, carrying its range', async () => {
    await boot({ query: FULL_QUERY });

    await send({ type: 'back' });

    expect(navigatedTo()).toEqual([
      `${APP_ROUTES.fleet}?bookingId=${BOOKING_ID}&startDate=2026-03-01&endDate=2026-03-31`,
    ]);
  });

  test('back to the daily screen carries the day instead', async () => {
    await boot({ query: { bookingId: BOOKING_ID, from: 'daily', date: '2026-03-10' } });

    await send({ type: 'back' });

    expect(navigatedTo()).toEqual([`${APP_ROUTES.daily}?date=2026-03-10`]);
  });

  test('back with nothing to carry is a bare route', async () => {
    await boot({ query: { bookingId: BOOKING_ID, from: 'home' } });

    await send({ type: 'back' });

    expect(navigatedTo()).toEqual([APP_ROUTES.home]);
  });

  test('an unknown return tab falls back to the daily screen', async () => {
    await boot({ query: { bookingId: BOOKING_ID, from: 'nowhere' } });

    await send({ type: 'back' });

    expect(navigatedTo()).toEqual([APP_ROUTES.daily]);
  });

  test('navigate goes to the route it names', async () => {
    await boot({ query: { bookingId: BOOKING_ID, from: 'daily' } });

    await send({ type: 'navigate', route: 'settings' });

    expect(navigatedTo()).toEqual([APP_ROUTES.settings]);
  });

  test('navigate with no route falls back to the return tab', async () => {
    await boot({ query: { bookingId: BOOKING_ID, from: 'bookings' } });

    await send({ type: 'navigate' });

    expect(navigatedTo()[0]).toContain(APP_ROUTES.bookings);
  });

  test('logout ends the session and returns to the backroom home', async () => {
    await boot();

    await send({ type: 'logout' });
    await flush();

    expect(navigatedTo()).toEqual([APP_ROUTES.home]);
    expect(ctx.fake.rows('StaffSessions').every((s) => s.active === false)).toBe(true);
  });
});

describe('resizing the frame', () => {
  beforeEach(async () => { await boot(); });

  test('a height inside the range is applied', async () => {
    await send({ type: 'resize', height: 3000 });

    expect(html.height).toBe(3000);
  });

  test('a short frame is held at the floor', async () => {
    await send({ type: 'resize', height: 10 });

    expect(html.height).toBe(1200);
  });

  test('a tall frame is capped', async () => {
    await send({ type: 'resize', height: 99999 });

    expect(html.height).toBe(5000);
  });

  test('a missing or unparseable height still lands on the floor', async () => {
    // Unlike the other backroom pages, this one has no "leave it alone" case:
    // Number(undefined) || 0 is 0, and 0 clamps up to the floor.
    await send({ type: 'resize' });
    expect(html.height).toBe(1200);

    await send({ type: 'resize', height: 'tall' });
    expect(html.height).toBe(1200);
  });

  test('a frame that rejects the height is logged rather than crashing the page', async () => {
    await ctx.teardown();
    const stubborn = createComponent(COMP);
    Object.defineProperty(stubborn, 'height', {
      get() { return undefined; },
      set() { throw new Error('read only'); },
    });
    await boot({ component: stubborn });

    await send({ type: 'resize', height: 3000 });

    expect(warns).toHaveBeenCalledWith('[Contract] resize height set failed', 'read only');
  });
});

describe('what the contract refuses to act on', () => {
  beforeEach(async () => {
    await boot();
    await load();
  });

  test('a message from an untrusted origin reaches nothing', async () => {
    const before = html.posted.length;
    await send({ type: 'reloadContract' }, 'https://evil.example');
    await send({ type: 'setBookingStatus', newStatus: 'Canceled' }, 'https://evil.example');
    await flush();

    expect(html.posted.length).toBe(before);
    expect(ctx.fake.rows('BookingsNew')[0].status).toBe('Confirmed');
  });

  test('an origin-less message is accepted', async () => {
    await send({ type: 'reloadContract' }, '');
    await flush();

    expect(of('loadContractData')).toHaveLength(2);
  });

  test('an unparseable payload, a null payload and a typeless object do nothing', async () => {
    const before = html.posted.length;
    await send('{ not json');
    await send(null);
    await send({ payload: {} });
    await flush();

    expect(html.posted.length).toBe(before);
  });

  test('a non-object payload is refused before it reaches the router', async () => {
    const before = html.posted.length;

    await send('42');
    await flush();

    expect(html.posted.length).toBe(before);
  });

  test('an unrecognised message type does nothing', async () => {
    const before = html.posted.length;

    await send({ type: 'selfDestruct' });
    await flush();

    expect(html.posted.length).toBe(before);
    expect(navigatedTo()).toEqual([]);
  });

  // The remaining mutation survivors on this file, all verified equivalent:
  //
  // - The booking id is trimmed here and again inside every backend that
  //   receives it, so removing the page's trim is unobservable.
  // - `returnTab`'s default is applied twice — once when read from the query,
  //   once inside buildReturnRoute — so neither copy is load-bearing alone.
  // - Both payload guards (`typeof msg === "object"`, `!msg.type`) are
  //   re-tested by every branch of the router, which compares msg.type against
  //   a literal.
  // - The document action's `|| "preview"` default is never read: the rendered
  //   branch posts the literal string "preview" regardless of what `action`
  //   holds, and the two branches that do read it compare against "capabilities"
  //   and "pdf".
});
