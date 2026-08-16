import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { createBooking } from '../bookingEngine.jsw';
import { clearPricingCatalogCache } from '../pricingCatalog.jsw';

// createBooking is the server-authoritative pricing path: it ignores any money the
// client sends and recomputes from the catalog, then refuses the booking if the
// category is already fully committed for the window. Both are worth holding down.

const VEHICLE_ID = 'veh-eco';
const CATEGORY_ID = 'ECO';

// January, so Athens is UTC+2 and outside the 22:00-08:00 night window.
const PICKUP = '2026-01-12T10:00';
const DROPOFF = '2026-01-15T10:00'; // 3 days

function baseSeed(overrides = {}) {
  return {
    VehiclesNew: [{
      _id: VEHICLE_ID,
      category: CATEGORY_ID,
      title: 'Hyundai i10',
      price: 45,   // createBooking reads vehicle.price as the per-day fallback rate
      active: true,
    }],
    FleetNew: [
      { _id: 'car-1', active: true, category: CATEGORY_ID, plate: 'AAA-1111' },
      { _id: 'car-2', active: true, category: CATEGORY_ID, plate: 'BBB-2222' },
    ],
    BookingsNew: [],
    BusinessSettings: [],
    InsurancePlans: [],
    ExtraServices: [],
    FeeRules: [],
    PricingSeasons: [],
    CategoryRateRules: [],
    PickupLocations: [],
    ...overrides,
  };
}

function bookingPayload(extra = {}) {
  return {
    vehicleId: VEHICLE_ID,
    categoryId: CATEGORY_ID,
    category: CATEGORY_ID,
    pickupDateTime: PICKUP,
    dropoffDateTime: DROPOFF,
    customerName: 'A Customer',
    phone: '+30 000',
    email: 'customer@example.com',
    selectedPackage: 'cdw',
    selectedExtras: [],
    driverAge: '30-40',
    ...extra,
  };
}

/** An existing booking occupying the same category for the same window. */
function occupying(id, overrides = {}) {
  return {
    _id: id,
    categoryId: CATEGORY_ID,
    status: 'Confirmed',
    pickupDateTime: '2026-01-12T08:00:00.000Z',
    dropoffDateTime: '2026-01-15T08:00:00.000Z',
    ...overrides,
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

describe('createBooking — required input', () => {
  test.each([
    ['vehicleId', { vehicleId: '' }],
    ['categoryId', { categoryId: '' }],
    ['pickupDateTime', { pickupDateTime: '' }],
    ['dropoffDateTime', { dropoffDateTime: '' }],
    ['customerName', { customerName: '' }],
    ['email', { email: '' }],
    ['phone', { phone: '' }],
  ])('refuses a booking missing %s', async (_field, patch) => {
    install();
    const result = await createBooking(bookingPayload(patch));
    expect(result.success).toBe(false);
    expect(fake.rows('BookingsNew')).toHaveLength(0);
  });

  test('refuses a dropoff at or before pickup', async () => {
    install();
    await expect(createBooking(bookingPayload({ dropoffDateTime: PICKUP })))
      .resolves.toMatchObject({ success: false });
    await expect(createBooking(bookingPayload({ dropoffDateTime: '2026-01-10T10:00' })))
      .resolves.toMatchObject({ success: false });
    expect(fake.rows('BookingsNew')).toHaveLength(0);
  });

  test('refuses unparseable dates', async () => {
    install();
    const result = await createBooking(bookingPayload({ pickupDateTime: 'not-a-date' }));
    expect(result.success).toBe(false);
  });
});

describe('createBooking — availability', () => {
  test('accepts a booking while the category still has a free vehicle', async () => {
    // Two cars in the category, one already committed for the window.
    install(baseSeed({ BookingsNew: [occupying('existing-1')] }));
    const result = await createBooking(bookingPayload());
    expect(result.success).toBe(true);
  });

  test('refuses a booking once every vehicle in the category is committed', async () => {
    // Two cars, two overlapping bookings — the category is full for this window.
    install(baseSeed({ BookingsNew: [occupying('existing-1'), occupying('existing-2')] }));
    const result = await createBooking(bookingPayload());
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/διαθεσιμότητα/i);
    expect(fake.rows('BookingsNew')).toHaveLength(2); // nothing added
  });

  test('ignores cancelled bookings when counting occupancy', async () => {
    // A cancelled booking must not consume a vehicle, or the fleet silently shrinks.
    install(baseSeed({
      BookingsNew: [occupying('existing-1'), occupying('cancelled-1', { status: 'Canceled' })],
    }));
    const result = await createBooking(bookingPayload());
    expect(result.success).toBe(true);
  });

  test('ignores bookings that do not overlap the requested window', async () => {
    install(baseSeed({
      BookingsNew: [
        occupying('past', { pickupDateTime: '2025-12-01T08:00:00.000Z', dropoffDateTime: '2025-12-05T08:00:00.000Z' }),
        occupying('future', { pickupDateTime: '2026-06-01T08:00:00.000Z', dropoffDateTime: '2026-06-05T08:00:00.000Z' }),
      ],
    }));
    const result = await createBooking(bookingPayload());
    expect(result.success).toBe(true);
  });

  test('allows overbooking when business settings permit it', async () => {
    install(baseSeed({
      BookingsNew: [occupying('existing-1'), occupying('existing-2')],
      BusinessSettings: [{ _id: 'bs-1', allowOverbooking: true, currency: 'EUR', vatRate: 24 }],
    }));
    const result = await createBooking(bookingPayload());
    expect(result.success).toBe(true);
  });
});

describe('createBooking — server-authoritative pricing', () => {
  test('prices from the catalog and stores the booking', async () => {
    install();
    const result = await createBooking(bookingPayload());
    expect(result.success).toBe(true);

    const [stored] = fake.rows('BookingsNew');
    expect(stored.baseCost).toBe(135);   // 45/day * 3 days
    expect(stored.totalPrice).toBeGreaterThan(0);
    expect(stored.bookingNumber).toMatch(/^RNT-\d{4}-\d{4}$/);
  });

  test('ignores prices supplied by the client', async () => {
    // The whole point of the price lock: a tampered payload must not set the price.
    install();
    await createBooking(bookingPayload({
      totalPrice: 1,
      baseCost: 1,
      basePricePerDay: 1,
      netAmount: 1,
      vatAmount: 0,
    }));

    const [stored] = fake.rows('BookingsNew');
    expect(stored.baseCost).toBe(135);
    expect(stored.totalPrice).not.toBe(1);
  });

  test('splits the stored total into net and VAT that add back up', async () => {
    install();
    await createBooking(bookingPayload());
    const [stored] = fake.rows('BookingsNew');
    expect(Number((stored.netAmount + stored.vatAmount).toFixed(2))).toBe(stored.totalPrice);
  });

  test('charges the young-driver fee for a 19-22 driver', async () => {
    install();
    await createBooking(bookingPayload({ driverAge: '19-22' }));
    const [stored] = fake.rows('BookingsNew');
    expect(stored.ageFee).toBe(16);
  });

  test('charges no age fee for a driver outside the surcharge bands', async () => {
    install();
    await createBooking(bookingPayload({ driverAge: '30-40' }));
    const [stored] = fake.rows('BookingsNew');
    expect(stored.ageFee).toBe(0);
  });

  test('bills three days for a 72-hour rental', async () => {
    install();
    await createBooking(bookingPayload());
    const [stored] = fake.rows('BookingsNew');
    expect(stored.billableDays).toBe(3);
  });

  test('writes the booking with suppressAuth as the options argument', async () => {
    install();
    await createBooking(bookingPayload());
    const insert = fake.calls.insert.find((c) => c.collection === 'BookingsNew');
    expect(insert.options).toEqual({ suppressAuth: true });
    expect(insert.item).not.toHaveProperty('suppressAuth');
  });
});
