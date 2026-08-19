import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { createBooking, getVehicleCategoryDetails, getVehicleCategoriesCatalog } from '../bookingEngine.jsw';
import { clearPricingCatalogCache } from '../pricingCatalog.jsw';

// The corners of bookingEngine the two createBooking suites do not reach: the
// booking-number sequence, the pickup-location surcharge, and the image
// normaliser that turns Wix's internal media references into URLs a browser can
// actually load.

const VEHICLE_ID = 'veh-eco';
const CATEGORY_ID = 'ECO';
const PICKUP = '2026-01-12T10:00';
const DROPOFF = '2026-01-15T10:00';

function seed(overrides = {}) {
  return {
    VehiclesNew: [{ _id: VEHICLE_ID, category: CATEGORY_ID, title: 'Hyundai i10', price: 45, active: true }],
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

const payload = (extra = {}) => ({
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
});

let fake;
const install = (overrides) => {
  clearPricingCatalogCache();
  fake = createFakeWixData(seed(overrides)).install(wixData);
  return fake;
};
const stored = (id) => fake.rows('BookingsNew').find((b) => b._id === id);

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
  clearPricingCatalogCache();
});

// Mutation survivors on this file, all verified equivalent and left alone:
//
// - Several guards in the location-fee lookup are already applied upstream by
//   normalizePickupLocation: the rounding, the 'both' default for a location
//   type, and the array-shape check on the catalogue. Removing any of them
//   changes nothing observable from here.
// - `if (!target) return 0` in the same function is redundant with the find
//   below it, which cannot match an empty string against any label or key.
// - The https early-return in the image normaliser is redundant with the
//   wix:image regex beneath it, which does not match an https url anyway.
// - `if (!value) return []` in toImageArray is redundant with the empty-string
//   check inside vehicleCategoryImageUrl.
// - The booking-number reader's `&& results.items[0].bookingNumber` guard is
//   redundant with the Number.isNaN check that follows it.
describe('the booking number sequence', () => {
  const year = new Date().getFullYear();

  test('the first booking of the year starts at 0001', async () => {
    install();

    const res = await createBooking(payload());

    expect(res.success).toBe(true);
    expect(res.bookingNumber).toBe(`RNT-${year}-0001`);
  });

  test('the next one continues from the highest number already issued', async () => {
    install({
      BookingsNew: [{
        _id: 'bk-old', bookingNumber: `RNT-${year}-0041`, status: 'Confirmed',
        pickupDateTime: '2020-01-01T00:00:00.000Z', dropoffDateTime: '2020-01-02T00:00:00.000Z',
      }],
    });

    const res = await createBooking(payload());

    expect(res.bookingNumber).toBe(`RNT-${year}-0042`);
  });

  test('the sequence is padded to four digits, and grows past them intact', async () => {
    install({
      BookingsNew: [{
        _id: 'bk-old', bookingNumber: `RNT-${year}-9999`, status: 'Confirmed',
        pickupDateTime: '2020-01-01T00:00:00.000Z', dropoffDateTime: '2020-01-02T00:00:00.000Z',
      }],
    });

    const res = await createBooking(payload());

    expect(res.bookingNumber).toBe(`RNT-${year}-10000`);
  });

  test('a previous number that is not parseable restarts the sequence rather than producing NaN', async () => {
    // The row is still the most recent one, so the alternative to restarting is
    // a booking numbered RNT-2026-NaN.
    install({
      BookingsNew: [{
        _id: 'bk-old', bookingNumber: `RNT-${year}-oops`, status: 'Confirmed',
        pickupDateTime: '2020-01-01T00:00:00.000Z', dropoffDateTime: '2020-01-02T00:00:00.000Z',
      }],
    });

    const res = await createBooking(payload());

    expect(res.bookingNumber).toBe(`RNT-${year}-0001`);
  });

  test('a row with no booking number at all is skipped over', async () => {
    install({
      BookingsNew: [{
        _id: 'bk-old', status: 'Confirmed',
        pickupDateTime: '2020-01-01T00:00:00.000Z', dropoffDateTime: '2020-01-02T00:00:00.000Z',
      }],
    });

    const res = await createBooking(payload());

    expect(res.bookingNumber).toBe(`RNT-${year}-0001`);
  });

  test('last year’s numbers do not carry into this one', async () => {
    install({
      BookingsNew: [{
        _id: 'bk-old', bookingNumber: `RNT-${year - 1}-0500`, status: 'Confirmed',
        pickupDateTime: '2020-01-01T00:00:00.000Z', dropoffDateTime: '2020-01-02T00:00:00.000Z',
      }],
    });

    const res = await createBooking(payload());

    expect(res.bookingNumber).toBe(`RNT-${year}-0001`);
  });
});

describe('the pickup and dropoff location surcharge', () => {
  const location = (extra = {}) => ({
    _id: 'p-1', key: 'hotel', label: 'Hotel delivery', address: 'Anywhere',
    active: true, extraFee: 25, locationType: 'both', ...extra,
  });

  test('a location with a fee adds it to the booking', async () => {
    install({ PickupLocations: [location()] });

    const res = await createBooking(payload({ pickuppoint: 'Hotel delivery' }));
    expect(res.success).toBe(true);

    expect(stored(res._id).locationFee).toBe(25);
  });

  test('the location can be named by its key as well as its label', async () => {
    install({ PickupLocations: [location()] });

    const res = await createBooking(payload({ pickuppoint: 'hotel' }));

    expect(stored(res._id).locationFee).toBe(25);
  });

  test('the pickup and dropoff fees are added together', async () => {
    install({
      PickupLocations: [location(), location({ _id: 'p-2', key: 'port', label: 'Port', extraFee: 10 })],
    });

    const res = await createBooking(payload({ pickuppoint: 'Hotel delivery', dropoffpoint: 'Port' }));

    expect(stored(res._id).locationFee).toBe(35);
  });

  test('a pickup-only location charges nothing on the return leg', async () => {
    install({ PickupLocations: [location({ locationType: 'pickup' })] });

    const res = await createBooking(payload({ pickuppoint: 'Hotel delivery', dropoffpoint: 'Hotel delivery' }));

    // Charged once, not twice: the same address used both ways is one delivery
    // when the location is only configured for pickup.
    expect(stored(res._id).locationFee).toBe(25);
    expect(stored(res._id).pickupLocationFee).toBe(25);
    expect(stored(res._id).dropoffLocationFee).toBe(0);
  });

  test('a dropoff-only location charges nothing on the outbound leg', async () => {
    install({ PickupLocations: [location({ locationType: 'dropoff' })] });

    const res = await createBooking(payload({ pickuppoint: 'Hotel delivery', dropoffpoint: 'Hotel delivery' }));

    expect(stored(res._id).locationFee).toBe(25);
    expect(stored(res._id).pickupLocationFee).toBe(0);
    expect(stored(res._id).dropoffLocationFee).toBe(25);
  });

  test('a location that charges nothing adds nothing', async () => {
    install({ PickupLocations: [location({ extraFee: 0 })] });

    const res = await createBooking(payload({ pickuppoint: 'Hotel delivery' }));

    expect(stored(res._id).locationFee).toBe(0);
  });

  test('an unknown location adds nothing rather than failing the booking', async () => {
    install({ PickupLocations: [location()] });

    const res = await createBooking(payload({ pickuppoint: 'Somewhere else entirely' }));

    expect(res.success).toBe(true);
    expect(stored(res._id).locationFee).toBe(0);
  });

  test('no location at all adds nothing', async () => {
    install({ PickupLocations: [location()] });

    const res = await createBooking(payload());

    expect(stored(res._id).locationFee).toBe(0);
  });

  test('the match ignores case and surrounding whitespace', async () => {
    install({ PickupLocations: [location()] });

    const res = await createBooking(payload({ pickuppoint: '  HOTEL DELIVERY  ' }));

    expect(stored(res._id).locationFee).toBe(25);
  });

  test('the fee is rounded to the cent', async () => {
    install({ PickupLocations: [location({ extraFee: 12.345 })] });

    const res = await createBooking(payload({ pickuppoint: 'Hotel delivery' }));

    expect(stored(res._id).locationFee).toBe(12.35);
  });

  test('the surcharge reaches the total the customer is quoted', async () => {
    install({ PickupLocations: [location()] });

    const withFee = await createBooking(payload({ pickuppoint: 'Hotel delivery' }));
    const withoutFee = await createBooking(payload({ email: 'other@example.com' }));

    expect(stored(withFee._id).totalPrice - stored(withoutFee._id).totalPrice).toBe(25);
  });
});

describe('the vehicle images a category carries', () => {
  const withImage = (image) => {
    install({ VehiclesNew: [{ _id: VEHICLE_ID, category: CATEGORY_ID, title: 'Hyundai i10', price: 45, active: true, image }] });
    return getVehicleCategoryDetails({ vehicleId: VEHICLE_ID });
  };

  test('an https url is passed through untouched', async () => {
    const item = await withImage('https://example.com/car.jpg');

    expect(item.photos).toContain('https://example.com/car.jpg');
  });

  test('a Wix media reference is rewritten to a URL a browser can load', async () => {
    // wix:image://v1/<file>/... is Wix's internal form; sending it to a browser
    // renders a broken image.
    const item = await withImage('wix:image://v1/abc123~mv2.jpg/car.jpg#originWidth=800&originHeight=600');

    expect(item.photos).toContain('https://static.wixstatic.com/media/abc123~mv2.jpg');
  });

  test('an object with a src is unwrapped', async () => {
    const item = await withImage({ src: 'https://example.com/car.jpg' });

    expect(item.photos).toContain('https://example.com/car.jpg');
  });

  test('an object with a url is unwrapped too', async () => {
    const item = await withImage({ url: 'https://example.com/car.jpg' });

    expect(item.photos).toContain('https://example.com/car.jpg');
  });

  test('a gallery of images is flattened into the list', async () => {
    const item = await withImage({
      gallery: ['https://example.com/a.jpg', { src: 'https://example.com/b.jpg' }],
    });

    expect(item.photos).toEqual(expect.arrayContaining([
      'https://example.com/a.jpg', 'https://example.com/b.jpg',
    ]));
  });

  test('a nested array is flattened rather than stringified', async () => {
    // Two entries in the inner array on purpose. A one-element array stringifies
    // to exactly its element, so a nested [x] would come out looking correct
    // even if nothing flattened it; [x, y] becomes "x,y" and gives the game away.
    const item = await withImage([
      ['https://example.com/a.jpg', 'https://example.com/c.jpg'],
      'https://example.com/b.jpg',
    ]);

    expect(item.photos).toEqual([
      'https://example.com/a.jpg', 'https://example.com/c.jpg', 'https://example.com/b.jpg',
    ]);
  });

  test('an empty or absent image produces no entries rather than a blank one', async () => {
    expect((await withImage('')).photos).toEqual([]);
    expect((await withImage(null)).photos).toEqual([]);
    expect((await withImage({})).photos).toEqual([]);
  });

  test('duplicates are collapsed', async () => {
    const item = await withImage(['https://example.com/a.jpg', 'https://example.com/a.jpg']);

    expect(item.photos).toEqual(['https://example.com/a.jpg']);
  });

  test('a relative path is kept as-is rather than guessed at', async () => {
    const item = await withImage('/media/car.jpg');

    expect(item.photos).toContain('/media/car.jpg');
  });

  test('the catalogue listing carries the same normalised images', async () => {
    install({
      VehiclesNew: [{
        _id: VEHICLE_ID, category: CATEGORY_ID, title: 'Hyundai i10', price: 45, active: true,
        image: 'wix:image://v1/abc123~mv2.jpg/car.jpg',
      }],
    });

    const rows = await getVehicleCategoriesCatalog();

    expect(rows[0].photos).toContain('https://static.wixstatic.com/media/abc123~mv2.jpg');
  });
});

describe('when the pricing catalogue cannot be read', () => {
  test('a booking is still priced, from the shipped defaults', async () => {
    // The alternative is refusing every booking while the CMS is unreachable,
    // which turns a catalogue outage into a total outage.
    install();
    const original = wixData.query;
    wixData.query = (name) => {
      if (['InsurancePlans', 'ExtraServices', 'FeeRules', 'BusinessSettings', 'PricingSeasons', 'CategoryRateRules', 'PickupLocations'].includes(name)) {
        throw new Error('collection missing');
      }
      return original.call(wixData, name);
    };
    let res;
    try {
      res = await createBooking(payload());
    } finally {
      wixData.query = original;
    }

    expect(res.success).toBe(true);
    expect(stored(res._id).totalPrice).toBeGreaterThan(0);
  });
});

describe('when the write itself fails', () => {
  test('the failure is reported rather than thrown at the caller', async () => {
    install();
    const original = wixData.insert;
    wixData.insert = (collection, ...rest) => (
      collection === 'BookingsNew'
        ? Promise.reject(new Error('collection is read-only'))
        : original.call(wixData, collection, ...rest)
    );
    try {
      expect(await createBooking(payload()))
        .toEqual({ success: false, message: 'collection is read-only' });
    } finally {
      wixData.insert = original;
    }
  });

  test('a thrown value with no message is still reported', async () => {
    install();
    const original = wixData.insert;
    wixData.insert = () => Promise.reject('just a string');
    try {
      expect(await createBooking(payload()))
        .toMatchObject({ success: false, message: 'just a string' });
    } finally {
      wixData.insert = original;
    }
  });
});

describe('the vehicle category behind a booking', () => {
  test('an inactive category is refused', async () => {
    install({ VehiclesNew: [{ _id: VEHICLE_ID, category: CATEGORY_ID, title: 'Hyundai i10', price: 45, active: false }] });

    expect(await createBooking(payload()))
      .toMatchObject({ success: false, message: 'Η κατηγορία οχήματος δεν είναι διαθέσιμη.' });
  });

  test('a category that does not exist is refused', async () => {
    install();

    expect(await createBooking(payload({ vehicleId: 'veh-nope' })))
      .toMatchObject({ success: false });
  });

  test('the category code is taken from the categoryId when it differs from the vehicle id', async () => {
    install();

    const res = await createBooking(payload({ categoryId: 'ECO', vehicleId: VEHICLE_ID }));

    expect(stored(res._id).categoryId).toBeTruthy();
  });

  test('a categoryId equal to the vehicle id falls back to the record’s own category', async () => {
    // A frame that sends the record id in both fields must not end up with the
    // id standing in for the category code — the booking would then be filed
    // under a category that does not exist.
    install();

    const res = await createBooking(payload({ categoryId: VEHICLE_ID, category: '' }));

    expect(res.success).toBe(true);
    expect(stored(res._id).vehicleCategoryCode).toBe(CATEGORY_ID);
  });
});
