import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { createBooking } from 'backend/bookingEngine';
import * as http from '../http-functions.js';

// The public HTTP surface — the only part of this backend reachable from the
// open internet without a Wix session. Two things carry the weight.
//
// The origin gate on post_createBooking is the whole of its authorisation: there
// is no token, no session, no signature. If it lets a request through, a booking
// is written. Everything else here is a read.
//
// get_bookingSummary recomputes money rather than echoing a stored total, so a
// coercion slip there shows a customer the wrong price. It already produced one
// bug: `??` guards null and undefined but not NaN, so a single non-numeric field
// poisoned the whole sum.

jest.mock('backend/bookingEngine', () => ({
  createBooking: jest.fn(async () => ({ success: true, bookingNumber: 'RNT-2026-0001', _id: 'bk-1' })),
}));

const SITE = 'diamondrentacar.gr';

// `host` defaults to the site; pass null to build a request with no host header
// at all (undefined would hit the default and quietly restore it).
function request({ origin, referer, host = SITE, query = {}, body = {} } = {}) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  if (referer !== undefined) headers.referer = referer;
  if (host) headers.host = host;
  return { headers, query, body: { json: async () => body } };
}

let fake;
function install(seed = {}) {
  fake = createFakeWixData(seed).install(wixData);
  return fake;
}

const ORIGINS_ENV = 'BOOKING_MUTATION_ALLOWED_ORIGINS';
let savedEnv;

beforeEach(() => {
  savedEnv = process.env[ORIGINS_ENV];
  delete process.env[ORIGINS_ENV];
  createBooking.mockClear();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ORIGINS_ENV];
  else process.env[ORIGINS_ENV] = savedEnv;
  if (fake) fake.restore();
  fake = null;
});

describe('the booking mutation origin gate', () => {
  // With no allowlist configured the gate falls back to "same site as the host
  // header". These are the cases that decide whether a stranger can POST a
  // booking into the database.
  test.each([
    ['the site itself over https', `https://${SITE}`, true],
    ['the site itself over http', `http://${SITE}`, true],
    ['an unrelated origin', 'https://evil.example', false],
    ['a lookalike suffix', `https://evil-${SITE}`, false],
    ['a subdomain of the site', `https://api.${SITE}`, false],
    ['the site as a subdomain of an attacker host', `https://${SITE}.evil.example`, false],
    ['no origin at all', undefined, false],
    ['an empty origin', '', false],
    ['a malformed origin', 'not-a-url', false],
  ])('%s is %s allowed to create a booking', async (_label, origin, allowed) => {
    install();
    const result = await http.post_createBooking(request({ origin }));
    expect(result.status).toBe(allowed ? 200 : 400);
    expect(result.body.success).toBe(allowed);
  });

  test('a rejected request never reaches the booking engine', async () => {
    // The gate failing open would be invisible in the response — the caller
    // still gets an error — but a booking would exist. This is the assertion
    // that distinguishes "refused" from "refused after doing the work".
    install();
    await http.post_createBooking(request({ origin: 'https://evil.example' }));
    expect(createBooking).not.toHaveBeenCalled();
  });

  test('an accepted request does reach the booking engine', async () => {
    install();
    const result = await http.post_createBooking(request({
      origin: `https://${SITE}`,
      body: { customerName: 'A Customer' },
    }));
    expect(createBooking).toHaveBeenCalledTimes(1);
    expect(result.body).toMatchObject({ success: true, bookingNumber: 'RNT-2026-0001', id: 'bk-1' });
  });

  test('a request with no host header is refused even from a plausible origin', async () => {
    // With no allowlist and no host there is nothing to compare against, so the
    // only safe answer is no.
    install();
    const result = await http.post_createBooking(request({ origin: `https://${SITE}`, host: null }));
    expect(result.body.success).toBe(false);
    expect(createBooking).not.toHaveBeenCalled();
  });

  test('the referer stands in when the origin header is absent', async () => {
    install();
    const result = await http.post_createBooking(request({
      referer: `https://${SITE}/booking/checkout?step=2`,
    }));
    expect(result.body.success).toBe(true);
  });

  test('only the origin part of the referer counts, not the path', async () => {
    // A path that merely mentions the site must not read as coming from it.
    install();
    const result = await http.post_createBooking(request({
      referer: `https://evil.example/https://${SITE}/checkout`,
    }));
    expect(result.body.success).toBe(false);
    expect(createBooking).not.toHaveBeenCalled();
  });

  test.each([
    ['a javascript: referer', 'javascript:alert(1)'],
    ['a data: referer', 'data:text/html,<script>fetch("/")</script>'],
    ['a file: referer', 'file:///tmp/attack.html'],
    ['a protocol-relative referer', `//${SITE}/checkout`],
    ['a referer naming the site in its query', `https://evil.example/?r=https://${SITE}`],
  ])('%s cannot create a booking', async (_label, referer) => {
    // These URLs have an opaque or absent origin. Whatever intermediate value
    // the parsing produces, the decision has to come out "no".
    install();
    const result = await http.post_createBooking(request({ referer }));
    expect(result.body.success).toBe(false);
    expect(createBooking).not.toHaveBeenCalled();
    expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  test('the origin header wins over the referer', async () => {
    install();
    const result = await http.post_createBooking(request({
      origin: 'https://evil.example',
      referer: `https://${SITE}/checkout`,
    }));
    expect(result.body.success).toBe(false);
  });
});

describe('the configured origin allowlist', () => {
  test('an allowlisted origin is accepted', async () => {
    process.env[ORIGINS_ENV] = 'https://booking.partner.example,https://www.diamondrentacar.gr';
    install();
    const result = await http.post_createBooking(request({ origin: 'https://booking.partner.example' }));
    expect(result.body.success).toBe(true);
  });

  test('the allowlist replaces the host fallback rather than adding to it', async () => {
    // Once an allowlist is configured, the site's own host is no longer implicitly
    // trusted. Treating the fallback as an addition would silently widen it.
    process.env[ORIGINS_ENV] = 'https://booking.partner.example';
    install();
    const result = await http.post_createBooking(request({ origin: `https://${SITE}` }));
    expect(result.body.success).toBe(false);
    expect(createBooking).not.toHaveBeenCalled();
  });

  test('entries are trimmed and blank ones ignored', async () => {
    process.env[ORIGINS_ENV] = '  https://booking.partner.example  , ,, ';
    install();
    const result = await http.post_createBooking(request({ origin: 'https://booking.partner.example' }));
    expect(result.body.success).toBe(true);
  });

  test('an allowlist entry is normalised, so a trailing path still matches', async () => {
    process.env[ORIGINS_ENV] = 'https://booking.partner.example/checkout/';
    install();
    const result = await http.post_createBooking(request({ origin: 'https://booking.partner.example' }));
    expect(result.body.success).toBe(true);
  });

  test('an allowlist of only unparseable entries falls back to the host check', async () => {
    // Every entry drops out as invalid, leaving an empty list — which must mean
    // "not configured", not "allow nothing" and not "allow everything".
    process.env[ORIGINS_ENV] = 'not-a-url, also-not-a-url';
    install();
    await expect(http.post_createBooking(request({ origin: `https://${SITE}` })))
      .resolves.toMatchObject({ body: { success: true } });
    await expect(http.post_createBooking(request({ origin: 'https://evil.example' })))
      .resolves.toMatchObject({ body: { success: false } });
  });

  test('the scheme is part of the match', async () => {
    process.env[ORIGINS_ENV] = 'https://booking.partner.example';
    install();
    const result = await http.post_createBooking(request({ origin: 'http://booking.partner.example' }));
    expect(result.body.success).toBe(false);
  });
});

describe('CORS headers on the mutation endpoint', () => {
  test('an allowed origin is echoed back', async () => {
    install();
    const result = await http.post_createBooking(request({ origin: `https://${SITE}` }));
    expect(result.headers['Access-Control-Allow-Origin']).toBe(`https://${SITE}`);
  });

  test('a refused origin is not echoed back, and no wildcard is offered', async () => {
    // The browser is the second line of defence here. Echoing the origin — or
    // falling back to "*" — on a rejection would hand the response to a page
    // that was just refused.
    install();
    const result = await http.post_createBooking(request({ origin: 'https://evil.example' }));
    expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  test('Vary: Origin is always set, so a rejection is never cached for everyone', async () => {
    install();
    for (const origin of [`https://${SITE}`, 'https://evil.example']) {
      const result = await http.post_createBooking(request({ origin }));
      expect(result.headers.Vary).toBe('Origin');
    }
  });

  test('the preflight applies the same gate as the POST', async () => {
    const allowed = http.options_createBooking(request({ origin: `https://${SITE}` }));
    const refused = http.options_createBooking(request({ origin: 'https://evil.example' }));
    expect(allowed.headers['Access-Control-Allow-Origin']).toBe(`https://${SITE}`);
    expect(refused.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  test('the preflight advertises POST', async () => {
    const result = http.options_createBooking(request({ origin: `https://${SITE}` }));
    expect(result.headers['Access-Control-Allow-Methods']).toContain('POST');
  });

  test('public read endpoints stay open to any origin', async () => {
    // Deliberately different from the mutation endpoint: reads are public data
    // and the booking UI is served from elsewhere. Pinned so the distinction is
    // a decision rather than an accident.
    install({ VehiclesNew: [] });
    const result = await http.get_vehicles(request({ origin: 'https://anywhere.example' }));
    expect(result.headers['Access-Control-Allow-Origin']).toBe('*');
  });
});

describe('post_createBooking error handling', () => {
  test('a refusal from the booking engine is passed through as a 400', async () => {
    install();
    createBooking.mockResolvedValueOnce({ success: false, message: 'No availability' });
    const result = await http.post_createBooking(request({ origin: `https://${SITE}` }));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ success: false, message: 'No availability' });
  });

  test('a thrown error becomes a 500 rather than escaping the handler', async () => {
    install();
    createBooking.mockRejectedValueOnce(new Error('collection offline'));
    const result = await http.post_createBooking(request({ origin: `https://${SITE}` }));
    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({ success: false, message: 'collection offline' });
  });

  test('unparseable JSON is refused without reaching the booking engine', async () => {
    install();
    const bad = request({ origin: `https://${SITE}` });
    bad.body.json = async () => { throw new Error('Unexpected token'); };
    const result = await http.post_createBooking(bad);
    expect(result.status).toBe(500);
    expect(createBooking).not.toHaveBeenCalled();
  });
});

describe('get_bookingSummary money', () => {
  function withBooking(over = {}) {
    return {
      BookingsNew: [{
        _id: 'bk-1',
        bookingNumber: 'RNT-2026-0001',
        pickupDateTime: '2026-03-10T09:00:00.000Z',
        dropoffDateTime: '2026-03-13T09:00:00.000Z',
        billableDays: 3,
        baseCost: 135,
        insuranceCost: 36,
        extrasTotal: 12,
        ageFee: 15,
        nightFee: 10,
        totalPrice: 208,
        ...over,
      }],
      VehiclesNew: [],
    };
  }
  // The money lives under `item`; `success` sits beside it on the envelope.
  const summary = async () => (await http.get_bookingSummary(request({ query: { booking: 'RNT-2026-0001' } }))).body.item;

  test('the total is the sum of its parts', async () => {
    install(withBooking());
    const envelope = (await http.get_bookingSummary(request({ query: { booking: 'RNT-2026-0001' } }))).body;
    expect(envelope.success).toBe(true);
    expect(envelope.item.total).toBe(208); // 135 + 36 + 12 + 15 + 10
  });

  test('a discount is subtracted, not added', async () => {
    install(withBooking({ pricingSnapshot: { breakdown: { rental: 135, insurance: 36, options: 12, ageFee: 15, nightFee: 10, discount: 20 } } }));
    expect((await summary()).total).toBe(188);
  });

  test('transport, damages and surcharges are added', async () => {
    // Zeroed elsewhere so the three under test are the only contributions.
    install(withBooking({
      baseCost: 0, insuranceCost: 0, extrasTotal: 0, ageFee: 0, nightFee: 0,
      pricingSnapshot: { breakdown: { rental: 100, transport: 20, damages: 5, surcharges: 3 } },
    }));
    expect((await summary()).total).toBe(128);
  });

  test('the pricing snapshot wins over the fields stored on the booking', async () => {
    // The snapshot is what was quoted; the loose fields drift.
    install(withBooking({ pricingSnapshot: { breakdown: { rental: 200, insurance: 50 } } }));
    const item = await summary();
    expect(item.baseCost).toBe(200);
    expect(item.insuranceCost).toBe(50);
  });

  test('the snapshot overrides field by field, not wholesale', async () => {
    // A breakdown carrying only `rental` must not zero out the extras and fees
    // stored on the booking — each line falls back independently.
    install(withBooking({ pricingSnapshot: { breakdown: { rental: 200 } } }));
    const item = await summary();
    expect(item.baseCost).toBe(200);      // from the snapshot
    expect(item.insuranceCost).toBe(36);  // from the booking
    expect(item.extrasCost).toBe(12);
    expect(item.ageFee).toBe(15);
    expect(item.nightFee).toBe(10);
    expect(item.total).toBe(273);
  });

  test('an explicit zero in the snapshot is honoured, not treated as absent', async () => {
    // `??` rather than `||` is the whole difference: a waived fee is a real
    // zero, and falling back to the booking's stored figure would re-add it.
    install(withBooking({ pricingSnapshot: { breakdown: { rental: 135, insurance: 0, options: 0, ageFee: 0, nightFee: 0 } } }));
    const item = await summary();
    expect(item.insuranceCost).toBe(0);
    expect(item.ageFee).toBe(0);
    expect(item.total).toBe(135);
  });

  test('a non-numeric component becomes zero rather than poisoning the total', async () => {
    // The bug this guard exists for: `??` passes NaN straight through, and one
    // NaN makes every downstream figure NaN — the endpoint reports NaN, not a price.
    install(withBooking({ baseCost: 'not-a-number' }));
    const item = await summary();
    expect(Number.isNaN(item.total)).toBe(false);
    expect(item.baseCost).toBe(0);
    expect(item.total).toBe(73); // 0 + 36 + 12 + 15 + 10
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['an object', {}],
  ])('a %s fee is treated as zero', async (_label, value) => {
    install(withBooking({ ageFee: value }));
    const item = await summary();
    expect(Number.isFinite(item.total)).toBe(true);
    expect(item.ageFee).toBe(0);
  });

  test('the stored total is used when there is nothing to recompute from', async () => {
    install(withBooking({
      baseCost: 0, insuranceCost: 0, extrasTotal: 0, ageFee: 0, nightFee: 0,
      basePricePerDay: 0, insuranceExtraPerDay: 0, totalPrice: 199,
    }));
    expect((await summary()).total).toBe(199);
  });

  test('a missing baseCost falls back to the daily rate times the days', async () => {
    install(withBooking({ baseCost: undefined, basePricePerDay: 45 }));
    expect((await summary()).baseCost).toBe(135); // 45 * 3
  });

  test('billable days are derived when not stored', async () => {
    install(withBooking({ billableDays: 0 }));
    expect((await summary()).days).toBe(3);
  });

  test('a same-day rental still bills one day', async () => {
    install(withBooking({
      billableDays: 0,
      pickupDateTime: '2026-03-10T09:00:00.000Z',
      dropoffDateTime: '2026-03-10T17:00:00.000Z',
    }));
    expect((await summary()).days).toBe(1);
  });

  test('a dropoff before the pickup still bills one day rather than a negative', async () => {
    install(withBooking({
      billableDays: 0,
      pickupDateTime: '2026-03-13T09:00:00.000Z',
      dropoffDateTime: '2026-03-10T09:00:00.000Z',
    }));
    expect((await summary()).days).toBe(1);
  });
});

describe('get_bookingSummary lookup', () => {
  test('a missing booking number is a 400', async () => {
    install({ BookingsNew: [] });
    const result = await http.get_bookingSummary(request({ query: {} }));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ success: false, message: 'Missing booking' });
  });

  test('an unknown booking number is a 400, not a 500', async () => {
    install({ BookingsNew: [] });
    const result = await http.get_bookingSummary(request({ query: { booking: 'RNT-NOPE' } }));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ success: false, message: 'Booking not found' });
  });

  test('a booking is found by its number, not its id', async () => {
    install({
      BookingsNew: [{ _id: 'bk-1', bookingNumber: 'RNT-2026-0001', totalPrice: 100 }],
      VehiclesNew: [],
    });
    const byId = await http.get_bookingSummary(request({ query: { booking: 'bk-1' } }));
    expect(byId.body.success).toBe(false);
    const byNumber = await http.get_bookingSummary(request({ query: { booking: 'RNT-2026-0001' } }));
    expect(byNumber.body.success).toBe(true);
  });

  test('a vehicle that cannot be loaded does not fail the whole summary', async () => {
    // The price is the point of this endpoint; a missing image should not
    // withhold it.
    install({
      BookingsNew: [{ _id: 'bk-1', bookingNumber: 'RNT-2026-0001', vehicleId: 'gone', totalPrice: 100 }],
      VehiclesNew: [],
    });
    const result = await http.get_bookingSummary(request({ query: { booking: 'RNT-2026-0001' } }));
    expect(result.body.success).toBe(true);
    expect(result.body.item.total).toBe(100);
  });
});

describe('get_vehicles', () => {
  const FLEET = {
    VehiclesNew: [
      { _id: 'v-1', title: 'ECO - Aygo', category: 'ECO', price: 35, active: true, transmission: 'Manual' },
      { _id: 'v-2', title: 'CMP - Polo', category: 'CMP', price: 45, active: true },
      { _id: 'v-3', title: 'ECO - Picanto', category: 'ECO', price: 30, active: false },
    ],
  };

  test('only active vehicles are published', async () => {
    // v-3 is inactive. Publishing it would offer a car that cannot be booked.
    install(FLEET);
    const body = (await http.get_vehicles(request())).body;
    expect(body.items.map((i) => i.id)).toEqual(['v-1', 'v-2']);
  });

  test('a category filter narrows the list', async () => {
    install(FLEET);
    const body = (await http.get_vehicles(request({ query: { category: 'ECO' } }))).body;
    expect(body.items.map((i) => i.id)).toEqual(['v-1']);
  });

  test.each([['all'], ['default'], ['']])('%s is treated as no filter', async (category) => {
    install(FLEET);
    const body = (await http.get_vehicles(request({ query: { category } }))).body;
    expect(body.items).toHaveLength(2);
  });

  test('the name drops the category prefix but the full title is kept', async () => {
    install(FLEET);
    const [first] = (await http.get_vehicles(request())).body.items;
    expect(first.name).toBe('Aygo');
    expect(first.title).toBe('ECO - Aygo');
  });

  test('a missing price becomes zero rather than NaN', async () => {
    install({ VehiclesNew: [{ _id: 'v-1', title: 'ECO - Aygo', price: 'free', active: true }] });
    const [first] = (await http.get_vehicles(request())).body.items;
    expect(first.price).toBe(0);
  });
});

describe('get_vehicle', () => {
  test('a missing id is a 400', async () => {
    install({ VehiclesNew: [] });
    const result = await http.get_vehicle(request({ query: {} }));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ success: false, message: 'Missing id' });
  });

  test('an inactive vehicle is reported as not found', async () => {
    // Not merely hidden from the list — a direct link must not reach it either.
    install({ VehiclesNew: [{ _id: 'v-3', title: 'ECO - Picanto', price: 30, active: false }] });
    const result = await http.get_vehicle(request({ query: { id: 'v-3' } }));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ success: false, message: 'Vehicle not found' });
  });

  test('an active vehicle is returned', async () => {
    install({ VehiclesNew: [{ _id: 'v-1', title: 'ECO - Aygo', price: 35, active: true }] });
    const result = await http.get_vehicle(request({ query: { id: 'v-1' } }));
    expect(result.body).toMatchObject({ success: true, item: { id: 'v-1', name: 'Aygo' } });
  });
});

describe('get_ping', () => {
  test('reports ok with a timestamp', async () => {
    const body = JSON.parse(http.get_ping(request()).body);
    expect(body.ok).toBe(true);
    expect(Number.isFinite(body.ts)).toBe(true);
  });
});

describe('the public pricing catalogue endpoint', () => {
  test('the catalogue is returned alongside a success flag', async () => {
    install({
      BusinessSettings: [{ _id: 'bs-1', currency: 'EUR' }],
      InsurancePlans: [{ _id: 'i-1', key: 'cdw', label: 'CDW', pricePerDay: 12, active: true }],
      ExtraServices: [], FeeRules: [], PricingSeasons: [], CategoryRateRules: [], PickupLocations: [],
    });
    const { clearPricingCatalogCache } = await import('../pricingCatalog.jsw');
    clearPricingCatalogCache();

    const res = await http.get_pricing_catalog(request());

    expect(res.body.success).toBe(true);
    expect(res.body.insurancePlans.map((r) => r.key)).toContain('cdw');
    clearPricingCatalogCache();
  });

  test('it is cacheable by nobody — the price must not be served stale', async () => {
    install({
      BusinessSettings: [], InsurancePlans: [], ExtraServices: [], FeeRules: [],
      PricingSeasons: [], CategoryRateRules: [], PickupLocations: [],
    });
    const { clearPricingCatalogCache } = await import('../pricingCatalog.jsw');
    clearPricingCatalogCache();

    const res = await http.get_pricing_catalog(request());

    expect(res.headers['Cache-Control']).toBe('no-store');
    clearPricingCatalogCache();
  });

  test('a failure is reported as a server error rather than as an empty catalogue', async () => {
    // An empty catalogue would render as a page with no insurance options and
    // no prices, which reads as "we sell nothing" rather than "try again".
    const pricing = await import('../pricingCatalog.jsw');
    const original = pricing.getPublicPricingCatalog;
    pricing.getPublicPricingCatalog = () => Promise.reject(new Error('catalogue offline'));
    try {
      const res = await http.get_pricing_catalog(request());

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ success: false, message: 'catalogue offline' });
    } finally {
      pricing.getPublicPricingCatalog = original;
    }
  });

  test('a thrown value with no message still names something', async () => {
    const pricing = await import('../pricingCatalog.jsw');
    const original = pricing.getPublicPricingCatalog;
    pricing.getPublicPricingCatalog = () => Promise.reject('just a string');
    try {
      expect((await http.get_pricing_catalog(request())).body)
        .toMatchObject({ success: false, message: 'just a string' });
    } finally {
      pricing.getPublicPricingCatalog = original;
    }
  });
});

describe('the vehicle listing endpoints', () => {
  const vehicle = (extra = {}) => ({
    _id: 'v-1', category: 'ECO', title: 'ECO - Fiat Panda', price: 30, active: true,
    transmission: 'Manual', fuelType: 'Petrol', seats: 5, doors: 5, airCondition: true, ...extra,
  });

  test('active vehicles are listed, cheapest first', async () => {
    install({ VehiclesNew: [
      vehicle({ _id: 'v-2', title: 'SUV - Jeep', category: 'SUV', price: 70 }),
      vehicle({ _id: 'v-1', price: 30 }),
    ] });

    const res = await http.get_vehicles(request());

    expect(res.body.items.map((i) => i.id)).toEqual(['v-1', 'v-2']);
  });

  test('an inactive vehicle is not listed', async () => {
    install({ VehiclesNew: [vehicle(), vehicle({ _id: 'v-2', active: false })] });

    expect((await http.get_vehicles(request())).body.items.map((i) => i.id)).toEqual(['v-1']);
  });

  test('a category filter narrows the list', async () => {
    install({ VehiclesNew: [vehicle(), vehicle({ _id: 'v-2', category: 'SUV' })] });

    const res = await http.get_vehicles(request({ query: { category: 'SUV' } }));

    expect(res.body.items.map((i) => i.id)).toEqual(['v-2']);
  });

  test.each(['all', 'default', ''])('the pseudo-category %p lists everything', async (category) => {
    install({ VehiclesNew: [vehicle(), vehicle({ _id: 'v-2', category: 'SUV' })] });

    const res = await http.get_vehicles(request({ query: { category } }));

    expect(res.body.items).toHaveLength(2);
  });

  test('the short name drops the category prefix the title carries', async () => {
    install({ VehiclesNew: [vehicle({ title: 'ECO - Fiat Panda' })] });

    const item = (await http.get_vehicles(request())).body.items[0];

    expect(item).toMatchObject({ name: 'Fiat Panda', title: 'ECO - Fiat Panda', label: 'ECO' });
  });

  test('a title with no prefix is used whole', async () => {
    install({ VehiclesNew: [vehicle({ title: 'Fiat Panda' })] });

    expect((await http.get_vehicles(request())).body.items[0].name).toBe('Fiat Panda');
  });

  test('a vehicle with no title at all falls back to its category', async () => {
    install({ VehiclesNew: [vehicle({ title: '' })] });

    expect((await http.get_vehicles(request())).body.items[0].name).toBe('ECO');
  });

  test('the specs the card renders are all present, with dashes for the gaps', async () => {
    install({ VehiclesNew: [vehicle({ transmission: '', fuelType: '', seats: '', airCondition: false })] });

    expect((await http.get_vehicles(request())).body.items[0].specs).toMatchObject({
      gearbox: '-', fuel: '-', seats: '-', doors: 5, ac: 'Όχι',
    });
  });

  test('a Wix media reference is rewritten into a loadable URL', async () => {
    install({ VehiclesNew: [vehicle({ image: 'wix:image://v1/abc123~mv2.jpg/car.jpg#originWidth=800' })] });

    expect((await http.get_vehicles(request())).body.items[0].image)
      .toBe('https://static.wixstatic.com/media/abc123~mv2.jpg');
  });

  test('an https image is passed through, and an object image is unwrapped', async () => {
    install({ VehiclesNew: [
      vehicle({ image: 'https://example.com/a.jpg' }),
      vehicle({ _id: 'v-2', price: 40, image: { src: 'https://example.com/b.jpg' } }),
    ] });

    expect((await http.get_vehicles(request())).body.items.map((i) => i.image))
      .toEqual(['https://example.com/a.jpg', 'https://example.com/b.jpg']);
  });

  test('a missing image is an empty string rather than a broken url', async () => {
    install({ VehiclesNew: [vehicle({ image: null })] });

    expect((await http.get_vehicles(request())).body.items[0].image).toBe('');
  });

  test('a failing query is reported as a server error', async () => {
    install({ VehiclesNew: [] });
    const original = wixData.query;
    wixData.query = () => { throw new Error('collection missing'); };
    try {
      const res = await http.get_vehicles(request());

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ success: false, message: 'collection missing' });
    } finally {
      wixData.query = original;
    }
  });

  test('a single vehicle can be fetched by id', async () => {
    install({ VehiclesNew: [vehicle()] });

    const res = await http.get_vehicle(request({ query: { id: 'v-1' } }));

    expect(res.body).toMatchObject({ success: true, item: { id: 'v-1', label: 'ECO' } });
  });

  test('a request with no id is refused', async () => {
    install({ VehiclesNew: [vehicle()] });

    const res = await http.get_vehicle(request({ query: {} }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, message: 'Missing id' });
  });

  test('an inactive vehicle is not fetchable by id either', async () => {
    // Same 400 as a vehicle that does not exist: a withdrawn category must not
    // be bookable through a saved link.
    install({ VehiclesNew: [vehicle({ active: false })] });

    const res = await http.get_vehicle(request({ query: { id: 'v-1' } }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, message: 'Vehicle not found' });
  });

  test('an id that matches nothing is reported the same way', async () => {
    install({ VehiclesNew: [vehicle()] });

    const res = await http.get_vehicle(request({ query: { id: 'v-nope' } }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, message: 'Vehicle not found' });
  });
});

describe('the CORS preflight and ping endpoints', () => {
  test.each([
    ['options_vehicle', 'options_vehicle'],
    ['options_vehicles', 'options_vehicles'],
    ['options_pricing_catalog', 'options_pricing_catalog'],
  ])('%s answers a preflight for GET only', (_label, name) => {
    const res = http[name](request());

    expect(res.headers).toMatchObject({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
  });

  test('none of the read preflights advertises POST', () => {
    // The only endpoint that accepts a POST is the booking mutation, and it has
    // its own preflight with its own origin gate. A read preflight advertising
    // POST would invite a browser to try one against an endpoint that has no
    // gate at all.
    for (const name of ['options_vehicle', 'options_vehicles', 'options_pricing_catalog']) {
      expect(http[name](request()).headers['Access-Control-Allow-Methods']).not.toContain('POST');
    }
  });

  test('ping answers ok with a timestamp', () => {
    const res = http.get_ping(request());

    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(typeof body.ts).toBe('number');
  });

  test('ping says nothing about the site beyond that it is up', () => {
    const body = http.get_ping(request()).body;

    expect(body).not.toMatch(/version|build|env|secret|host/i);
  });
});
