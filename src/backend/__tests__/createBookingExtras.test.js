import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { createBooking } from '../bookingEngine.jsw';
import { clearPricingCatalogCache } from '../pricingCatalog.jsw';

// What an extra costs, and who gets to decide.
//
// createBooking is a .jsw export and every method in permissions.json is
// anonymous, so this payload arrives straight from the browser. The top-level
// money fields were already locked down and tested; the extras were not. A
// payload could name its own price per extra, and the sum of those lines went
// into the stored total unchecked — a supplied 0 made an extra free, a supplied
// negative drove the whole booking below zero, and a supplied billingMode
// turned a per-day extra into a single charge.
//
// The site's own checkout sends plain string keys, so nothing legitimate ever
// used the object form's pricing fields. These tests hold that shut.

const VEHICLE_ID = 'veh-eco';
const CATEGORY_ID = 'ECO';

// January: Athens is UTC+2 and outside the 22:00-08:00 night window, so no fees
// beyond the ones under test. Three billable days.
const PICKUP = '2026-01-12T10:00';
const DROPOFF = '2026-01-15T10:00';
const DAYS = 3;
const BASE_TOTAL = 135; // 45/day * 3

const GPS = { _id: 'x-gps', key: 'gps', label: 'GPS', price: 10, billingMode: 'perDay', active: true, publicVisible: true };
const SEAT = { _id: 'x-seat', key: 'seat', label: 'Baby seat', price: 21, billingMode: 'perBooking', active: true, publicVisible: true };

function baseSeed(extraServices = [GPS, SEAT]) {
  return {
    VehiclesNew: [{ _id: VEHICLE_ID, category: CATEGORY_ID, title: 'Hyundai i10', price: 45, active: true }],
    FleetNew: [
      { _id: 'car-1', active: true, category: CATEGORY_ID, plate: 'AAA-1111' },
      { _id: 'car-2', active: true, category: CATEGORY_ID, plate: 'BBB-2222' },
    ],
    BookingsNew: [],
    BusinessSettings: [],
    InsurancePlans: [],
    ExtraServices: extraServices,
    FeeRules: [],
    PricingSeasons: [],
    CategoryRateRules: [],
    PickupLocations: [],
  };
}

function payload(extra = {}) {
  return {
    vehicleId: VEHICLE_ID,
    categoryId: CATEGORY_ID,
    category: CATEGORY_ID,
    pickupDateTime: PICKUP,
    dropoffDateTime: DROPOFF,
    customerName: 'A Customer',
    phone: '+30 000',
    email: 'customer@example.com',
    selectedPackage: '',
    driverAge: '30-40',
    ...extra,
  };
}

let fake;
function install(seed = baseSeed()) {
  clearPricingCatalogCache(); // the catalog caches for 60s across tests
  fake = createFakeWixData(seed).install(wixData);
  return fake;
}

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
  clearPricingCatalogCache();
});

/** Book with these extras and hand back the stored row. */
async function book(selectedExtras) {
  const result = await createBooking(payload({ selectedExtras }));
  expect(result.success).toBe(true);
  const [stored] = fake.rows('BookingsNew');
  return stored;
}

describe('extras priced from the catalog', () => {
  test('a per-day extra is charged for every billable day', async () => {
    install();
    const stored = await book(['gps']);
    expect(stored.extrasTotal).toBe(10 * DAYS);
    expect(stored.totalPrice).toBe(BASE_TOTAL + 30);
  });

  test('a per-booking extra is charged once, however long the rental', async () => {
    install();
    const stored = await book(['seat']);
    expect(stored.extrasTotal).toBe(21);
  });

  test('several extras add up', async () => {
    install();
    const stored = await book(['gps', 'seat']);
    expect(stored.extrasTotal).toBe(30 + 21);
    expect(stored.totalPrice).toBe(BASE_TOTAL + 51);
  });

  test('the same extra asked for twice is charged once', async () => {
    install();
    const stored = await book(['gps', 'gps']);
    expect(stored.extrasTotal).toBe(30);
  });

  test('no extras costs nothing', async () => {
    install();
    const stored = await book([]);
    expect(stored.extrasTotal).toBe(0);
    expect(stored.totalPrice).toBe(BASE_TOTAL);
  });
});

describe('a payload cannot set its own price', () => {
  // Each of these is the same booking as 'a per-day extra is charged for every
  // billable day' above, with a price bolted onto the payload. All of them must
  // still cost 30.
  test.each([
    ['price', { key: 'gps', price: 0 }],
    ['pricePerDay', { key: 'gps', pricePerDay: 0 }],
    ['amount', { key: 'gps', amount: 0 }],
    ['a price of zero', { key: 'gps', price: 0 }],
    ['a fractional price', { key: 'gps', price: 0.01 }],
    ['a string price', { key: 'gps', price: '0' }],
  ])('ignores %s in the payload', async (_label, extra) => {
    install();
    const stored = await book([extra]);
    expect(stored.extrasTotal).toBe(30);
    expect(stored.totalPrice).toBe(BASE_TOTAL + 30);
  });

  test('a negative price cannot pull the booking total down', async () => {
    // The worst version: before the fix this stored a total of -2865 on a
    // booking that should cost 165.
    install();
    const stored = await book([{ key: 'gps', price: -1000 }]);
    expect(stored.extrasTotal).toBe(30);
    expect(stored.totalPrice).toBe(BASE_TOTAL + 30);
    expect(stored.totalPrice).toBeGreaterThan(0);
  });

  test('a negative price on an extra that does not exist cannot either', async () => {
    install();
    const stored = await book([{ key: 'not-a-real-extra', price: -1000 }]);
    expect(stored.extrasTotal).toBe(0);
    expect(stored.totalPrice).toBe(BASE_TOTAL);
  });

  test('several tampered extras cannot add up to a discount', async () => {
    install();
    const stored = await book([
      { key: 'gps', price: -500 },
      { key: 'seat', price: -500 },
    ]);
    expect(stored.extrasTotal).toBe(30 + 21);
    expect(stored.totalPrice).toBe(BASE_TOTAL + 51);
  });

  test('an inflated price is ignored too, not only a reduced one', async () => {
    // The lock is on where the number comes from, not on which direction it
    // moves. A booking that overcharges is still a booking priced by its buyer.
    install();
    const stored = await book([{ key: 'gps', price: 9999 }]);
    expect(stored.extrasTotal).toBe(30);
  });
});

describe('a payload cannot set the billing mode', () => {
  test('a per-day extra stays per-day however the payload labels it', async () => {
    // Before the fix this billed 10 instead of 30.
    install();
    const stored = await book([{ key: 'gps', mode: 'perBooking' }]);
    expect(stored.extrasTotal).toBe(30);
  });

  test('the billingMode spelling is refused as well as mode', async () => {
    install();
    const stored = await book([{ key: 'gps', billingMode: 'perBooking' }]);
    expect(stored.extrasTotal).toBe(30);
  });

  test('a per-booking extra cannot be turned into a per-day charge', async () => {
    // The mirror case, which overcharges rather than undercharges: 21 for the
    // booking, not 21 a day.
    install();
    const stored = await book([{ key: 'seat', mode: 'perDay' }]);
    expect(stored.extrasTotal).toBe(21);
  });

  test('an unrecognised billing mode on the stored row is read as per-day', async () => {
    // Settled by the catalog normaliser rather than here — anything that is not
    // perBooking becomes perDay before createBooking sees it. Asserted through
    // createBooking because that is where getting it wrong shows up as money.
    install(baseSeed([{ ...GPS, billingMode: 'perFortnight' }]));
    const stored = await book(['gps']);
    expect(stored.extrasTotal).toBe(30);
  });

  test('a stored row with no billing mode at all is read as per-day', async () => {
    const { billingMode: _billingMode, ...withoutMode } = GPS;
    install(baseSeed([withoutMode]));
    const stored = await book(['gps']);
    expect(stored.extrasTotal).toBe(30);
  });
});

describe('a payload cannot set the label', () => {
  test('the catalog label is what lands on the booking', async () => {
    // The label is copied onto the booking record and from there onto the
    // contract, so it is not purely cosmetic.
    install();
    const stored = await book([{ key: 'gps', label: 'Free upgrade — no charge' }]);
    expect(stored.extras).toBe('GPS');
    expect(JSON.stringify(stored)).not.toContain('Free upgrade');
  });

  test('an extra with no catalog row is labelled by its key', async () => {
    install();
    const stored = await book([{ key: 'mystery-item', label: 'Anything at all' }]);
    expect(stored.extras).toBe('mystery-item');
    expect(JSON.stringify(stored)).not.toContain('Anything at all');
  });
});

describe('an extra with no catalog row', () => {
  test('is recorded on the booking', async () => {
    // Chosen over refusing the booking or dropping the key: a page cached from
    // before a catalog edit still books, and the desk can see what was asked for.
    install();
    const stored = await book(['gps', 'made-up-thing']);
    expect(stored.selectedExtras).toEqual(['gps', 'made-up-thing']);
  });

  test('costs nothing', async () => {
    install();
    const stored = await book(['made-up-thing']);
    expect(stored.extrasTotal).toBe(0);
    expect(stored.totalPrice).toBe(BASE_TOTAL);
  });

  test('does not change what the real extras cost', async () => {
    install();
    const stored = await book(['gps', 'made-up-thing']);
    expect(stored.extrasTotal).toBe(30);
  });
});

describe('what the catalog itself says', () => {
  test('a catalog price of zero is honoured', async () => {
    install(baseSeed([{ ...GPS, price: 0 }]));
    const stored = await book(['gps']);
    expect(stored.extrasTotal).toBe(0);
  });

  test('a negative price stored in the catalog is floored at zero', async () => {
    // upsertExtraService refuses a negative price, but seeds, imports and direct
    // collection edits do not go through it, and this is the number that reaches
    // the total.
    install(baseSeed([{ ...GPS, price: -50 }]));
    const stored = await book(['gps']);
    expect(stored.extrasTotal).toBe(0);
    expect(stored.totalPrice).toBe(BASE_TOTAL);
  });

  test('a price written as pricePerDay is read, not treated as missing', async () => {
    // Also settled upstream: the catalog normaliser accepts either spelling, so
    // createBooking only ever sees `price`. Kept because a row saved through the
    // admin form under one spelling and priced under the other would be a silent
    // zero on the bill.
    const { price: _price, ...withoutPrice } = GPS;
    install(baseSeed([{ ...withoutPrice, pricePerDay: 10 }]));
    const stored = await book(['gps']);
    expect(stored.extrasTotal).toBe(30);
  });

  test('a row with no price at all costs nothing rather than NaN', async () => {
    const { price: _price, ...withoutPrice } = GPS;
    install(baseSeed([withoutPrice]));
    const stored = await book(['gps']);
    expect(stored.extrasTotal).toBe(0);
    expect(Number.isFinite(stored.totalPrice)).toBe(true);
    expect(stored.totalPrice).toBe(BASE_TOTAL);
  });
});

describe('the stored total stays consistent', () => {
  test('net and VAT still add back up to the total once extras are on it', async () => {
    install();
    const stored = await book(['gps', 'seat']);
    expect(Number((stored.netAmount + stored.vatAmount).toFixed(2))).toBe(stored.totalPrice);
  });

  test('a tampered payload does not desynchronise the pricing snapshot from the total', async () => {
    // The snapshot is the frozen record of what was quoted. If it took the
    // payload's numbers while the total took the catalog's, the contract and the
    // bill would disagree.
    install();
    const stored = await book([{ key: 'gps', price: 0, mode: 'perBooking' }]);
    expect(stored.pricingSnapshot.breakdown.options).toBe(30);
    expect(stored.pricingSnapshot.breakdown.gross).toBe(stored.totalPrice);
  });
});
