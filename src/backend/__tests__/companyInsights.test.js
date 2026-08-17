import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import { getCompanyInsights } from '../rentalContract.jsw';

// The corporate account page: every booking billed to a company, what the
// company has spent, what it still owes.
//
// The twin of the customer profile, and the same question — which bookings
// belong to this account — but with a sharper failure mode, because company
// names share words as a matter of course. Half the businesses in a country end
// in the same legal suffix.
//
// Unlike a person, a company has a registered name, and the VAT number is the
// identifier that actually settles it. So the name is matched exactly here,
// where a person's is matched by whole words.

const STAFF = 'staff@example.com';
const PASSWORD = 'correct-horse-battery';

function seed({ bookings = [], rentals = [], companies = [] } = {}) {
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
    Companies: companies,
    BookingsNew: bookings,
    RentalsNew: rentals,
  };
}

let fake;
function install(s) {
  fake = createFakeWixData(seed(s)).install(wixData);
  return fake;
}

async function token() {
  const { sessionToken } = await loginStaff({ email: STAFF, password: PASSWORD });
  return sessionToken;
}

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

async function insights(company, extra = {}) {
  const result = await getCompanyInsights({ authToken: await token(), company, ...extra });
  expect(result.success).toBe(true);
  return result;
}

const numbers = (result) => (result.history || []).map((h) => h.bookingNumber).sort();

let counter = 0;
const booking = (billing = {}, over = {}) => {
  counter += 1;
  return {
    _id: `cb${counter}`,
    bookingNumber: `CO-${counter}`,
    customerName: 'A Customer',
    email: `cb${counter}@example.com`,
    pickupDateTime: '2026-03-10T09:00:00.000Z',
    dropoffDateTime: '2026-03-13T09:00:00.000Z',
    totalPrice: 100,
    billing: { invoiceType: 'invoice', ...billing },
    ...over,
  };
};

// Four separate businesses. Three of them share words with the first.
const COMPANIES = [
  booking({ companyName: 'Diamond Rentals Ltd', vatNumber: '111' }, { _id: 'k1', bookingNumber: 'CO-1', totalPrice: 100 }),
  booking({ companyName: 'Diamond Travel Ltd', vatNumber: '222' }, { _id: 'k2', bookingNumber: 'CO-2', totalPrice: 700 }),
  booking({ companyName: 'Blue Diamond Rentals Ltd', vatNumber: '333' }, { _id: 'k3', bookingNumber: 'CO-3', totalPrice: 900 }),
  booking({ companyName: 'Acme Ltd', vatNumber: '444' }, { _id: 'k4', bookingNumber: 'CO-4', totalPrice: 500 }),
];

describe('matching a company by name', () => {
  test('finds that company\'s own bookings', async () => {
    install({ bookings: COMPANIES });
    expect(numbers(await insights({ companyName: 'Diamond Rentals Ltd' }))).toEqual(['CO-1']);
  });

  test('a longer name containing it is a different business', async () => {
    // "Blue Diamond Rentals Ltd" contains every word of "Diamond Rentals Ltd".
    // It used to be merged in, taking its 900 with it.
    install({ bookings: COMPANIES });
    expect(numbers(await insights({ companyName: 'Diamond Rentals Ltd' }))).not.toContain('CO-3');
  });

  test('a word shared between businesses does not merge them', async () => {
    install({ bookings: COMPANIES });
    expect(numbers(await insights({ companyName: 'Diamond' }))).toEqual([]);
  });

  test('a legal suffix on its own matches nothing at all', async () => {
    // The worst of the old cases: searching "Ltd" returned every company on the
    // books as a single corporate account worth 2200.
    install({ bookings: COMPANIES });
    const result = await insights({ companyName: 'Ltd' });
    expect(numbers(result)).toEqual([]);
    expect(result.summary.lifetimeGross).toBe(0);
  });

  test('the lifetime spend is that company\'s alone', async () => {
    install({ bookings: COMPANIES });
    expect((await insights({ companyName: 'Diamond Rentals Ltd' })).summary.lifetimeGross).toBe(100);
    expect((await insights({ companyName: 'Blue Diamond Rentals Ltd' })).summary.lifetimeGross).toBe(900);
  });

  test('case and surrounding space do not matter', async () => {
    install({ bookings: COMPANIES });
    expect(numbers(await insights({ companyName: '  DIAMOND rentals LTD ' }))).toEqual(['CO-1']);
  });

  test('an empty name matches nothing rather than everything', async () => {
    install({ bookings: COMPANIES });
    expect(numbers(await insights({ companyName: '   ' }))).toEqual([]);
  });

  test('a booking with no company name is not matched by a name', async () => {
    install({ bookings: [booking({ companyName: '', vatNumber: '' })] });
    expect(numbers(await insights({ companyName: 'Diamond Rentals Ltd' }))).toEqual([]);
  });
});

describe('matching a company by trade name', () => {
  const TRADING = [
    booking({ companyName: 'Kappa Holdings Ltd', tradeName: 'Diamond Cars', vatNumber: '551' }, { _id: 't1', bookingNumber: 'T-1', totalPrice: 100 }),
    booking({ companyName: 'Lambda Holdings Ltd', tradeName: 'Diamond Cars North', vatNumber: '552' }, { _id: 't2', bookingNumber: 'T-2', totalPrice: 800 }),
  ];

  test('finds bookings taken under a trading name', async () => {
    install({ bookings: TRADING });
    expect(numbers(await insights({ tradeName: 'Diamond Cars' }))).toEqual(['T-1']);
  });

  test('a longer trading name is a different business', async () => {
    install({ bookings: TRADING });
    expect(numbers(await insights({ tradeName: 'Diamond Cars' }))).not.toContain('T-2');
  });

  test('the registered name and the trading name are both accepted', async () => {
    install({ bookings: TRADING });
    expect(numbers(await insights({ companyName: 'Kappa Holdings Ltd' }))).toEqual(['T-1']);
    expect(numbers(await insights({ tradeName: 'Diamond Cars' }))).toEqual(['T-1']);
  });
});

describe('the identifiers that actually settle it', () => {
  test('a VAT number finds the company whatever the name says', async () => {
    install({ bookings: COMPANIES });
    expect(numbers(await insights({ vatNumber: '333' }))).toEqual(['CO-3']);
  });

  test('a different VAT number is a different company', async () => {
    install({ bookings: COMPANIES });
    expect(numbers(await insights({ vatNumber: '999' }))).toEqual([]);
  });

  test('a VAT number and a name together do not narrow each other', async () => {
    // Worth knowing: the clauses are OR'd, so a mismatched pair returns the union
    // rather than nothing. Pinned as it is.
    install({ bookings: COMPANIES });
    expect(numbers(await insights({ vatNumber: '444', companyName: 'Diamond Rentals Ltd' }))).toEqual(['CO-1', 'CO-4']);
  });

  test('a company email finds its bookings', async () => {
    install({ bookings: [booking({ companyName: 'Somebody Else Ltd', companyEmail: 'accounts@diamond.gr' })] });
    expect(numbers(await insights({ companyEmail: 'accounts@diamond.gr' }))).toHaveLength(1);
  });

  test('an email is matched regardless of case', async () => {
    install({ bookings: [booking({ companyName: 'Somebody Else Ltd', companyEmail: 'accounts@diamond.gr' })] });
    expect(numbers(await insights({ companyEmail: 'ACCOUNTS@DIAMOND.GR' }))).toHaveLength(1);
  });

  test('a company phone is matched on its digits', async () => {
    install({ bookings: [booking({ companyName: 'Somebody Else Ltd', phone: '+30 2310 111 222' })] });
    expect(numbers(await insights({ phone: '+30 2310 111 222' }))).toHaveLength(1);
  });
});

describe('where the billing details come from', () => {
  test('the rental\'s billing wins over the booking\'s', async () => {
    // A desk correcting the company on the contract has to be what counts.
    install({
      bookings: [booking({ companyName: 'Wrong Name Ltd', vatNumber: '000' }, { _id: 'r1', bookingNumber: 'R-1' })],
      rentals: [{ _id: 'rent-1', bookingId: 'r1', billing: { companyName: 'Diamond Rentals Ltd', vatNumber: '111', invoiceType: 'invoice' } }],
    });
    expect(numbers(await insights({ companyName: 'Diamond Rentals Ltd' }))).toEqual(['R-1']);
    expect(numbers(await insights({ companyName: 'Wrong Name Ltd' }))).toEqual([]);
  });

  test('the rental\'s trade name wins too, not only its registered name', async () => {
    // Both fields are merged the same way, and each is matched separately, so
    // asserting one leaves the other free to drift.
    install({
      bookings: [booking({ companyName: 'Kappa Holdings Ltd', tradeName: 'Wrong Trading Name' }, { _id: 'r3', bookingNumber: 'R-3' })],
      rentals: [{ _id: 'rent-3', bookingId: 'r3', billing: { companyName: 'Kappa Holdings Ltd', tradeName: 'Diamond Cars', invoiceType: 'invoice' } }],
    });
    expect(numbers(await insights({ tradeName: 'Diamond Cars' }))).toEqual(['R-3']);
    expect(numbers(await insights({ tradeName: 'Wrong Trading Name' }))).toEqual([]);
  });

  test('the booking\'s billing is used when the rental has none', async () => {
    install({
      bookings: [booking({ companyName: 'Diamond Rentals Ltd', vatNumber: '111' }, { _id: 'r2', bookingNumber: 'R-2' })],
      rentals: [{ _id: 'rent-2', bookingId: 'r2' }],
    });
    expect(numbers(await insights({ companyName: 'Diamond Rentals Ltd' }))).toEqual(['R-2']);
  });

  test('reads the stored company record when given an id', async () => {
    install({
      companies: [{ _id: 'co-1', companyName: 'Diamond Rentals Ltd', vatNumber: '111' }],
      bookings: COMPANIES,
    });
    const result = await insights({ companyId: 'co-1' });
    expect(numbers(result)).toEqual(['CO-1']);
    expect(result.profile).toMatchObject({ companyName: 'Diamond Rentals Ltd' });
  });

  test('the stored record wins over what the caller passed', async () => {
    // The id identifies the account; anything else in the payload is a hint that
    // may be stale. Reading the payload first would look up a different company
    // than the one asked for.
    install({
      companies: [{ _id: 'co-1', companyName: 'Diamond Rentals Ltd', vatNumber: '111' }],
      bookings: COMPANIES,
    });
    const result = await insights({ companyId: 'co-1', companyName: 'Acme Ltd', vatNumber: '444' });
    expect(result.profile.companyName).toBe('Diamond Rentals Ltd');
    expect(numbers(result)).toEqual(['CO-1']);
  });

  test('a company id that matches nothing falls back to what was passed', async () => {
    install({ bookings: COMPANIES });
    expect(numbers(await insights({ companyId: 'no-such-company', companyName: 'Acme Ltd' }))).toEqual(['CO-4']);
  });

  test('refuses an unauthenticated caller', async () => {
    install({ bookings: COMPANIES });
    await expect(getCompanyInsights({ company: { companyName: 'Acme Ltd' } })).rejects.toThrow('AUTH_REQUIRED');
    await expect(getCompanyInsights({ authToken: 'made-up', company: { companyName: 'Acme Ltd' } })).rejects.toThrow('AUTH_REQUIRED');
  });
});

describe('the money on the account', () => {
  const HISTORY = [
    booking({ companyName: 'Acme Ltd', vatNumber: '444' }, { _id: 'm1', bookingNumber: 'M-1', totalPrice: 100, prepaidAmount: 30, depositAmount: 200, pickupDateTime: '2020-01-10T09:00:00.000Z', dropoffDateTime: '2020-01-13T09:00:00.000Z' }),
    booking({ companyName: 'Acme Ltd', vatNumber: '444' }, { _id: 'm2', bookingNumber: 'M-2', totalPrice: 250, prepaidAmount: 50, paidNowAmount: 20, depositAmount: 300, pickupDateTime: '2021-06-01T09:00:00.000Z', dropoffDateTime: '2021-06-05T09:00:00.000Z' }),
    booking({ companyName: 'Acme Ltd', vatNumber: '444' }, { _id: 'm3', bookingNumber: 'M-3', totalPrice: 400, prepaidAmount: 100, pickupDateTime: '2099-01-01T09:00:00.000Z', dropoffDateTime: '2099-01-05T09:00:00.000Z' }),
  ];

  test('counts the bookings and separates past from future', async () => {
    install({ bookings: HISTORY });
    const { summary } = await insights({ companyName: 'Acme Ltd' });
    expect(summary.totalBookings).toBe(3);
    expect(summary.pastBookings).toBe(2);
    expect(summary.futureBookings).toBe(1);
  });

  test('adds up the lifetime gross', async () => {
    install({ bookings: HISTORY });
    expect((await insights({ companyName: 'Acme Ltd' })).summary.lifetimeGross).toBe(750);
  });

  test('keeps deposits separate from money collected', async () => {
    install({ bookings: HISTORY });
    const { summary } = await insights({ companyName: 'Acme Ltd' });
    expect(summary.collected).toBe(200);
    expect(summary.deposits).toBe(500);
  });

  test('reports the value still ahead', async () => {
    install({ bookings: HISTORY });
    expect((await insights({ companyName: 'Acme Ltd' })).summary.futureGross).toBe(400);
  });

  test('an account with nothing on it is zeroes, not an error', async () => {
    install({ bookings: COMPANIES });
    const result = await insights({ companyName: 'Nobody Ltd' });
    expect(result.history).toEqual([]);
    expect(result.summary).toMatchObject({ totalBookings: 0, lifetimeGross: 0, avgTicket: 0 });
  });

  test('the totals are rounded after adding up', async () => {
    install({ bookings: [
      booking({ companyName: 'Acme Ltd' }, { _id: 'f1', bookingNumber: 'F-1', totalPrice: 0.1 }),
      booking({ companyName: 'Acme Ltd' }, { _id: 'f2', bookingNumber: 'F-2', totalPrice: 0.2 }),
    ] });
    expect((await insights({ companyName: 'Acme Ltd' })).summary.lifetimeGross).toBe(0.3);
  });

  test('the history is newest first', async () => {
    install({ bookings: HISTORY });
    expect((await insights({ companyName: 'Acme Ltd' })).history.map((h) => h.bookingNumber))
      .toEqual(['M-3', 'M-2', 'M-1']);
  });

  test('the number of bookings returned can be limited', async () => {
    install({ bookings: HISTORY });
    expect((await insights({ companyName: 'Acme Ltd' }, { limit: 2 })).history).toHaveLength(2);
  });
});
