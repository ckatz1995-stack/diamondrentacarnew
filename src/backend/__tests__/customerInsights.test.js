import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import { getCustomerInsights } from '../rentalContract.jsw';

// The customer profile a desk reads before deciding anything: every booking this
// person has made, what they have spent over their lifetime, what they still owe.
//
// Which bookings belong to the person is the whole question. Matching too
// narrowly loses their history; matching too widely puts somebody else's rentals
// and somebody else's spend on the page — and the desk cannot tell, because the
// profile does not say which booking matched on what.
//
// The money is then summed off whatever that match returned, so a matching bug
// is a money bug too.

const STAFF = 'staff@example.com';
const PASSWORD = 'correct-horse-battery';

function seed({ bookings = [], rentals = [], customers = [] } = {}) {
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
    Customers: customers,
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

async function insights(customer, extra = {}) {
  const result = await getCustomerInsights({ authToken: await token(), customer, ...extra });
  expect(result.success).toBe(true);
  return result;
}

const numbers = (result) => result.history.map((h) => h.bookingNumber).sort();

let counter = 0;
const booking = (over = {}) => {
  counter += 1;
  return {
    _id: `b${counter}`,
    bookingNumber: `RNT-${counter}`,
    customerName: 'Anna Smith',
    email: 'anna@example.com',
    phone: '+30 2310 111 222',
    pickupDateTime: '2026-03-10T09:00:00.000Z',
    dropoffDateTime: '2026-03-13T09:00:00.000Z',
    totalPrice: 100,
    ...over,
  };
};

describe('matching a customer by name', () => {
  // The five people used across this block. Only the first is Anna Smith.
  const PEOPLE = [
    booking({ _id: 'p1', bookingNumber: 'RNT-1', customerName: 'Anna Smith', email: 'anna@x.com', phone: '111', totalPrice: 100 }),
    booking({ _id: 'p2', bookingNumber: 'RNT-2', customerName: 'Ann', email: 'ann@y.com', phone: '222', totalPrice: 200 }),
    booking({ _id: 'p3', bookingNumber: 'RNT-3', customerName: 'Joanna Smithson', email: 'jo@z.com', phone: '333', totalPrice: 300 }),
    booking({ _id: 'p4', bookingNumber: 'RNT-4', customerName: 'A', email: 'a@w.com', phone: '444', totalPrice: 400 }),
    booking({ _id: 'p5', bookingNumber: 'RNT-5', customerName: 'Anna M Smith', email: 'anna2@x.com', phone: '555', totalPrice: 500 }),
  ];

  test('finds the bookings that really are that person', async () => {
    install({ bookings: PEOPLE });
    expect(numbers(await insights({ fullName: 'Anna Smith' }))).toEqual(['RNT-1', 'RNT-5']);
  });

  test('a middle name in the booking does not lose it', async () => {
    // The direction that is kept: the booking may carry more words than the
    // name being looked up.
    install({ bookings: PEOPLE });
    expect(numbers(await insights({ fullName: 'Anna Smith' }))).toContain('RNT-5');
  });

  test('a longer name that merely contains the searched one is not that person', async () => {
    // "Joanna Smithson" contains "anna smith" as raw text. It used to match, and
    // it put a stranger's 300 into Anna Smith's lifetime spend.
    install({ bookings: PEOPLE });
    expect(numbers(await insights({ fullName: 'Anna Smith' }))).not.toContain('RNT-3');
  });

  test('a shorter name is not everybody', async () => {
    // The reverse containment, now gone: a booking recorded against "A" used to
    // join the history of anyone whose name contained an A.
    install({ bookings: PEOPLE });
    const result = await insights({ fullName: 'A' });
    expect(numbers(result)).toEqual(['RNT-4']);
  });

  test('two people sharing a surname are not the same person', async () => {
    // The commonest way a loose match goes wrong, and the one the fixture above
    // cannot show because no two of those names share a word. Requiring EVERY
    // word is what separates them; requiring any one word would merge the two
    // families' histories and their spend.
    install({ bookings: [
      booking({ _id: 's1', bookingNumber: 'S-1', customerName: 'Anna Smith', email: 'anna@x.com', phone: '111', totalPrice: 100 }),
      booking({ _id: 's2', bookingNumber: 'S-2', customerName: 'Bob Smith', email: 'bob@x.com', phone: '222', totalPrice: 700 }),
      booking({ _id: 's3', bookingNumber: 'S-3', customerName: 'Anna Jones', email: 'aj@x.com', phone: '333', totalPrice: 900 }),
    ] });
    const result = await insights({ fullName: 'Anna Smith' });
    expect(numbers(result)).toEqual(['S-1']);
    expect(result.summary.lifetimeGross).toBe(100);
  });

  test('a booking with no name is not swept in by a phone that only half matches', async () => {
    // Reaches the empty-name guard, which the plain "no name" case cannot: this
    // booking IS fetched, by the last-six-digits phone query, and then has to be
    // rejected. Its digits do not match and it has no name to match either.
    install({ bookings: [
      booking({ _id: 'e1', bookingNumber: 'E-1', customerName: '', email: 'nobody@x.com', phone: '999 111222', totalPrice: 400 }),
    ] });
    const result = await insights({ fullName: 'Anna Smith', phone: '111222' });
    expect(numbers(result)).toEqual([]);
    expect(result.summary.lifetimeGross).toBe(0);
  });

  test('a partial first name does not sweep up the full ones', async () => {
    install({ bookings: PEOPLE });
    expect(numbers(await insights({ fullName: 'Ann' }))).toEqual(['RNT-2']);
  });

  test('the lifetime spend is that person\'s alone', async () => {
    // The number this is all for. It used to read 400 for Anna Smith, and 1000
    // for a customer named "A".
    install({ bookings: PEOPLE });
    expect((await insights({ fullName: 'Anna Smith' })).summary.lifetimeGross).toBe(600);
    expect((await insights({ fullName: 'A' })).summary.lifetimeGross).toBe(400);
    expect((await insights({ fullName: 'Ann' })).summary.lifetimeGross).toBe(200);
  });

  test('case and surrounding space do not matter', async () => {
    install({ bookings: [booking({ customerName: 'Anna Smith' })] });
    expect(numbers(await insights({ fullName: '  ANNA smith ' }))).toHaveLength(1);
  });

  test('the order of the words does not matter', async () => {
    // Records written surname-first are ordinary.
    install({ bookings: [booking({ customerName: 'Smith Anna' })] });
    expect(numbers(await insights({ fullName: 'Anna Smith' }))).toHaveLength(1);
  });

  test('punctuation between words is not a difference', async () => {
    install({ bookings: [booking({ customerName: 'Anna-Maria  Smith' })] });
    expect(numbers(await insights({ fullName: 'Anna Maria Smith' }))).toHaveLength(1);
  });

  test('a Greek name matches on its own words', async () => {
    install({ bookings: [
      booking({ _id: 'g1', bookingNumber: 'GR-1', customerName: 'Γιώργος Παπαδόπουλος', email: 'g@x.com', phone: '901' }),
      booking({ _id: 'g2', bookingNumber: 'GR-2', customerName: 'Μαρία Παπαδοπούλου', email: 'm@x.com', phone: '902' }),
    ] });
    expect(numbers(await insights({ fullName: 'Γιώργος Παπαδόπουλος' }))).toEqual(['GR-1']);
  });

  test('an empty name matches nobody rather than everybody', async () => {
    install({ bookings: PEOPLE });
    expect(numbers(await insights({ fullName: '   ' }))).toEqual([]);
  });

  test('a booking with no name at all is not matched by a name', async () => {
    install({ bookings: [booking({ customerName: '', email: 'nobody@x.com', phone: '999' })] });
    expect(numbers(await insights({ fullName: 'Anna Smith' }))).toEqual([]);
  });
});

describe('matching by email and phone', () => {
  test('an email finds the booking', async () => {
    install({ bookings: [booking({ customerName: 'Someone Else', email: 'anna@example.com' })] });
    expect(numbers(await insights({ email: 'anna@example.com' }))).toHaveLength(1);
  });

  test('an email is matched regardless of case', async () => {
    install({ bookings: [booking({ customerName: 'Someone Else', email: 'anna@example.com' })] });
    expect(numbers(await insights({ email: 'ANNA@EXAMPLE.COM' }))).toHaveLength(1);
  });

  test('a different email is a different person', async () => {
    install({ bookings: [booking({ customerName: 'Someone Else', email: 'other@example.com' })] });
    expect(numbers(await insights({ email: 'anna@example.com' }))).toEqual([]);
  });

  test('a phone written exactly as it is stored finds the booking', async () => {
    install({ bookings: [booking({ customerName: 'Someone Else', email: 'x@x.com', phone: '+30 2310 111 222' })] });
    expect(numbers(await insights({ phone: '+30 2310 111 222' }))).toHaveLength(1);
  });

  test('a differently spaced number is still found when the digits agree', async () => {
    // What the extra last-six-digits query is for: it widens the candidate net
    // past the exact-string equality, and the digits-to-digits comparison then
    // confirms. Both sides here are the same number, spaced differently.
    install({ bookings: [booking({ customerName: 'Someone Else', email: 'x@x.com', phone: '0030 2310 111222' })] });
    expect(numbers(await insights({ phone: '00302310111222' }))).toHaveLength(1);
  });

  test('a phone in any other format is not found, and that is a query limit', async () => {
    // Written down rather than left as a surprise. The comparison the matcher
    // makes is digits-to-digits and would accept these, but candidates are
    // fetched by an equality on the phone as stored plus a contains on the seed's
    // last six digits — so a number stored with spaces is never offered to the
    // matcher when the seed has none. Nothing reaches the code that would say
    // yes. Storing normalised phone numbers is what would fix it, not a change
    // here.
    install({ bookings: [booking({ customerName: 'Someone Else', email: 'x@x.com', phone: '+30 2310 111 222' })] });
    expect(numbers(await insights({ phone: '302310111222' }))).toEqual([]);
    expect(numbers(await insights({ phone: '+302310111222' }))).toEqual([]);
  });

  test('a different phone is a different person', async () => {
    install({ bookings: [booking({ customerName: 'Someone Else', email: 'x@x.com', phone: '+30 2310 999 888' })] });
    expect(numbers(await insights({ phone: '+30 2310 111 222' }))).toEqual([]);
  });

  test('a seed that matches nothing returns an empty profile, not an error', async () => {
    install({ bookings: [booking()] });
    const result = await insights({ email: 'stranger@example.com' });
    expect(result.history).toEqual([]);
    expect(result.summary.totalBookings).toBe(0);
    expect(result.summary.lifetimeGross).toBe(0);
  });
});

describe('the profile that comes back', () => {
  test('echoes the customer it was asked about', async () => {
    install({ bookings: [booking()] });
    const result = await insights({ fullName: 'Anna Smith', email: 'anna@example.com', phone: '+30 2310 111 222' });
    expect(result.profile).toMatchObject({
      fullName: 'Anna Smith',
      email: 'anna@example.com',
      phone: '+30 2310 111 222',
    });
  });

  test('reads the stored customer record when given an id', async () => {
    install({
      customers: [{ _id: 'cust-1', fullName: 'Anna Smith', email: 'anna@example.com', mobilePhone: '+30 2310 111 222' }],
      bookings: [booking()],
    });
    const result = await insights({ customerId: 'cust-1' });
    expect(result.profile).toMatchObject({ customerId: 'cust-1', fullName: 'Anna Smith' });
    expect(numbers(result)).toHaveLength(1);
  });

  test('the stored record wins over what the caller passed', async () => {
    install({
      customers: [{ _id: 'cust-1', fullName: 'Anna Smith', email: 'anna@example.com' }],
      bookings: [booking()],
    });
    const result = await insights({ customerId: 'cust-1', fullName: 'Someone Else', email: 'wrong@example.com' });
    expect(result.profile.fullName).toBe('Anna Smith');
  });

  test('a customer id that matches nothing falls back to what was passed', async () => {
    install({ bookings: [booking()] });
    const result = await insights({ customerId: 'no-such-customer', fullName: 'Anna Smith' });
    expect(result.profile.fullName).toBe('Anna Smith');
    expect(numbers(result)).toHaveLength(1);
  });

  test('a first and last name on the record are joined', async () => {
    install({
      customers: [{ _id: 'cust-1', firstName: 'Anna', lastName: 'Smith' }],
      bookings: [booking()],
    });
    expect((await insights({ customerId: 'cust-1' })).profile.fullName).toBe('Anna Smith');
  });

  test('refuses an unauthenticated caller', async () => {
    install({ bookings: [booking()] });
    await expect(getCustomerInsights({ customer: { fullName: 'Anna Smith' } })).rejects.toThrow('AUTH_REQUIRED');
    await expect(getCustomerInsights({ authToken: 'made-up', customer: { fullName: 'Anna Smith' } })).rejects.toThrow('AUTH_REQUIRED');
  });
});

describe('the money on the profile', () => {
  const HISTORY = [
    booking({ _id: 'm1', bookingNumber: 'M-1', totalPrice: 100, prepaidAmount: 30, depositAmount: 200, pickupDateTime: '2020-01-10T09:00:00.000Z', dropoffDateTime: '2020-01-13T09:00:00.000Z' }),
    booking({ _id: 'm2', bookingNumber: 'M-2', totalPrice: 250, prepaidAmount: 50, paidNowAmount: 20, depositAmount: 300, pickupDateTime: '2021-06-01T09:00:00.000Z', dropoffDateTime: '2021-06-05T09:00:00.000Z' }),
    booking({ _id: 'm3', bookingNumber: 'M-3', totalPrice: 400, prepaidAmount: 100, depositAmount: 0, pickupDateTime: '2099-01-01T09:00:00.000Z', dropoffDateTime: '2099-01-05T09:00:00.000Z' }),
  ];

  test('counts the bookings', async () => {
    install({ bookings: HISTORY });
    expect((await insights({ fullName: 'Anna Smith' })).summary.totalBookings).toBe(3);
  });

  test('separates what is past from what is still to come', async () => {
    install({ bookings: HISTORY });
    const { summary } = await insights({ fullName: 'Anna Smith' });
    expect(summary.pastBookings).toBe(2);
    expect(summary.futureBookings).toBe(1);
  });

  test('adds up the lifetime gross', async () => {
    install({ bookings: HISTORY });
    expect((await insights({ fullName: 'Anna Smith' })).summary.lifetimeGross).toBe(750);
  });

  test('counts collected money as prepaid plus paid at the desk', async () => {
    install({ bookings: HISTORY });
    expect((await insights({ fullName: 'Anna Smith' })).summary.collected).toBe(200);
  });

  test('adds up deposits separately from payments', async () => {
    // A deposit is held, not earned; counting it as revenue would overstate what
    // the customer has actually spent.
    install({ bookings: HISTORY });
    const { summary } = await insights({ fullName: 'Anna Smith' });
    expect(summary.deposits).toBe(500);
    expect(summary.collected).toBe(200);
  });

  test('reports the value still ahead separately', async () => {
    install({ bookings: HISTORY });
    expect((await insights({ fullName: 'Anna Smith' })).summary.futureGross).toBe(400);
  });

  test('averages the ticket over the bookings', async () => {
    install({ bookings: HISTORY });
    expect((await insights({ fullName: 'Anna Smith' })).summary.avgTicket).toBe(250);
  });

  test('an average over no bookings is zero rather than a division by zero', async () => {
    install({ bookings: [booking()] });
    expect((await insights({ email: 'stranger@example.com' })).summary.avgTicket).toBe(0);
  });

  test('money is reported to the cent', async () => {
    install({ bookings: [booking({ totalPrice: 33.333, prepaidAmount: 11.111 })] });
    const { summary } = await insights({ fullName: 'Anna Smith' });
    expect(summary.lifetimeGross).toBe(33.33);
    expect(summary.collected).toBe(11.11);
  });

  test('the totals are rounded after adding up, not only before', async () => {
    // Each line is rounded on its own, so a per-line assertion cannot see the
    // rounding of the sum. 0.1 + 0.2 is 0.30000000000000004 in binary floating
    // point, and that is what a customer's lifetime spend would read as.
    install({ bookings: [
      booking({ _id: 'f1', bookingNumber: 'F-1', totalPrice: 0.1, prepaidAmount: 0.1, depositAmount: 0.1 }),
      booking({ _id: 'f2', bookingNumber: 'F-2', totalPrice: 0.2, prepaidAmount: 0.2, depositAmount: 0.2 }),
    ] });
    const { summary } = await insights({ fullName: 'Anna Smith' });
    expect(summary.lifetimeGross).toBe(0.3);
    expect(summary.collected).toBe(0.3);
    expect(summary.deposits).toBe(0.3);
  });

  test('a booking carrying no money at all does not poison the totals', async () => {
    install({ bookings: [
      booking({ _id: 'n1', bookingNumber: 'N-1', totalPrice: 100 }),
      booking({ _id: 'n2', bookingNumber: 'N-2', totalPrice: undefined, prepaidAmount: undefined }),
    ] });
    const { summary } = await insights({ fullName: 'Anna Smith' });
    expect(Number.isFinite(summary.lifetimeGross)).toBe(true);
    expect(Number.isNaN(summary.lifetimeGross)).toBe(false);
  });

  test('the amounts come from the rental when the booking does not carry them', async () => {
    install({
      bookings: [booking({ _id: 'r1', bookingNumber: 'R-1', totalPrice: 100, prepaidAmount: undefined })],
      rentals: [{ _id: 'rent-1', bookingId: 'r1', prepaidAmount: 40, depositAmount: 150 }],
    });
    const { summary } = await insights({ fullName: 'Anna Smith' });
    expect(summary.collected).toBe(40);
    expect(summary.deposits).toBe(150);
  });
});

describe('the history list', () => {
  test('is newest first', async () => {
    install({ bookings: [
      booking({ _id: 'h1', bookingNumber: 'H-1', pickupDateTime: '2020-01-01T09:00:00.000Z' }),
      booking({ _id: 'h2', bookingNumber: 'H-2', pickupDateTime: '2024-01-01T09:00:00.000Z' }),
      booking({ _id: 'h3', bookingNumber: 'H-3', pickupDateTime: '2022-01-01T09:00:00.000Z' }),
    ] });
    const result = await insights({ fullName: 'Anna Smith' });
    expect(result.history.map((h) => h.bookingNumber)).toEqual(['H-2', 'H-3', 'H-1']);
  });

  test('names the last completed and the next upcoming booking', async () => {
    install({ bookings: [
      booking({ _id: 'h1', bookingNumber: 'PAST-1', pickupDateTime: '2020-01-01T09:00:00.000Z', dropoffDateTime: '2020-01-05T09:00:00.000Z' }),
      booking({ _id: 'h2', bookingNumber: 'FUTURE-1', pickupDateTime: '2099-01-01T09:00:00.000Z', dropoffDateTime: '2099-01-05T09:00:00.000Z' }),
    ] });
    const { summary } = await insights({ fullName: 'Anna Smith' });
    expect(summary.lastNextLabel).toBe('Last PAST-1 · Next FUTURE-1');
  });

  test('says so plainly when there is neither', async () => {
    install({ bookings: [booking()] });
    expect((await insights({ email: 'stranger@example.com' })).summary.lastNextLabel).toBe('—');
  });

  test('each entry carries what the desk needs to identify the booking', async () => {
    install({ bookings: [booking({ category: 'ECO' })] });
    const [entry] = (await insights({ fullName: 'Anna Smith' })).history;
    expect(entry).toMatchObject({ bookingId: expect.any(String), bookingNumber: 'RNT-' + counter, category: 'ECO' });
    expect(entry.pickupDateTime).toBe('2026-03-10T09:00:00.000Z');
  });

  test('a booking with no dates is shown with a dash rather than an invalid date', async () => {
    install({ bookings: [booking({ pickupDateTime: '', dropoffDateTime: '' })] });
    const [entry] = (await insights({ fullName: 'Anna Smith' })).history;
    expect(entry.pickupLabel).toBe('—');
    expect(entry.dropoffLabel).toBe('—');
    expect(entry.isFuture).toBe(false);
    expect(entry.isPast).toBe(false);
  });

  test('the same booking found by two seeds is listed once', async () => {
    // The lookup runs several queries and unions them; a booking matching on both
    // email and name would otherwise be counted twice, and its money doubled.
    install({ bookings: [booking({ customerName: 'Anna Smith', email: 'anna@example.com', totalPrice: 100 })] });
    const result = await insights({ fullName: 'Anna Smith', email: 'anna@example.com' });
    expect(result.history).toHaveLength(1);
    expect(result.summary.lifetimeGross).toBe(100);
  });

  test('the limit still holds when several searches each contribute rows', async () => {
    // With a single seed the per-query cap already bounds the result, so the
    // final slice does nothing and a test using one seed cannot see it. Here the
    // email search and the name search return different rows, and the slice is
    // the only thing keeping the caller to what they asked for.
    install({ bookings: [
      booking({ _id: 'q1', bookingNumber: 'Q-1', customerName: 'Zed One', email: 'anna@example.com', phone: '1' }),
      booking({ _id: 'q2', bookingNumber: 'Q-2', customerName: 'Zed Two', email: 'anna@example.com', phone: '2' }),
      booking({ _id: 'q3', bookingNumber: 'Q-3', customerName: 'Anna Smith', email: 'other1@x.com', phone: '3' }),
      booking({ _id: 'q4', bookingNumber: 'Q-4', customerName: 'Anna Smith', email: 'other2@x.com', phone: '4' }),
    ] });
    const result = await insights({ fullName: 'Anna Smith', email: 'anna@example.com' }, { limit: 2 });
    expect(result.history).toHaveLength(2);
    expect(result.summary.totalBookings).toBe(2);
  });

  test('the number of bookings returned can be limited', async () => {
    install({ bookings: [
      booking({ _id: 'l1', bookingNumber: 'L-1', pickupDateTime: '2020-01-01T09:00:00.000Z' }),
      booking({ _id: 'l2', bookingNumber: 'L-2', pickupDateTime: '2021-01-01T09:00:00.000Z' }),
      booking({ _id: 'l3', bookingNumber: 'L-3', pickupDateTime: '2022-01-01T09:00:00.000Z' }),
    ] });
    const result = await insights({ fullName: 'Anna Smith' }, { limit: 2 });
    expect(result.history).toHaveLength(2);
    // The cap is applied to each candidate query before the results are sorted,
    // so it is the first two rows the collection returned that survive, not the
    // two most recent. Pinned as it is rather than as it reads: a caller asking
    // for "the last 2 bookings" is not getting that.
    expect(result.history.map((h) => h.bookingNumber)).toEqual(['L-2', 'L-1']);
  });
});

// Four mutations of this code survive every test here, and each is equivalent
// rather than a gap:
//
//   - the empty-name guard inside the matcher never fires, because the caller
//     already checks `seeds.fullName` before reaching it;
//   - fetching candidates by the shortest word rather than the longest finds the
//     same people, since a match requires every word to be present — the choice
//     only changes how many strangers are fetched and then discarded;
//   - trimming the whole-string candidate query changes nothing while the
//     single-word query runs alongside it;
//   - the `totalBookings ? ... : 0` guard on the average is redundant, because
//     round2 coerces through `Number(value || 0)` and NaN is falsy, so 0/0
//     already comes back as 0.
//
// Written down so the next person does not spend the afternoon re-deriving it.
