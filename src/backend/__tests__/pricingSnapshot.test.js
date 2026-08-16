import { buildPricingSnapshot } from '../pricingSnapshot.js';

// The snapshot is the frozen record of what a customer was quoted: it is written
// once at createBooking and read back later by the contract and the bill. If it
// disagrees with the booking it was built from, the disagreement surfaces as a
// customer being charged something other than what they agreed to — and by then
// the numbers that could settle the argument are gone.
//
// normalizeExtraDetails was the uncovered half of this file, and it is the half
// that turns a list of chosen extras into money.
//
// Everything here goes through buildPricingSnapshot, which is the only export.

const CATALOG = {
  businessSettings: { _id: 'bs-1', currency: 'EUR', vatRateDecimal: 0.24 },
  insurancePlans: [
    { _id: 'ins-cdw', key: 'cdw', label: 'CDW', pricePerDay: 12 },
    { _id: 'ins-fdw', key: 'fdw', label: 'Full cover', price: 20 },
  ],
  extraServices: [
    { _id: 'x-gps', key: 'gps', label: 'GPS', price: 10, billingMode: 'perDay' },
    { _id: 'x-seat', key: 'seat', label: 'Baby seat', price: 21, billingMode: 'perBooking' },
  ],
};

function snapshot(over = {}) {
  return buildPricingSnapshot({
    catalog: CATALOG,
    booking: { billableDays: 3, basePricePerDay: 45, ...over.booking },
    ...over,
  });
}

describe('extras chosen by key alone', () => {
  test('a per-day extra is priced for every day', () => {
    const [line] = snapshot({ selectedExtrasDetails: ['gps'] }).selectedExtras;
    expect(line).toMatchObject({ key: 'gps', label: 'GPS', billingMode: 'perDay', unitPrice: 10, quantity: 3, lineTotal: 30 });
  });

  test('a per-booking extra is priced once and its quantity says so', () => {
    const [line] = snapshot({ selectedExtrasDetails: ['seat'] }).selectedExtras;
    expect(line).toMatchObject({ billingMode: 'perBooking', unitPrice: 21, quantity: 1, lineTotal: 21 });
  });

  test('the catalog row is recorded, so the line can be traced back', () => {
    const [line] = snapshot({ selectedExtrasDetails: ['gps'] }).selectedExtras;
    expect(line.refId).toBe('x-gps');
  });

  test('a key with no catalog row is kept at zero rather than dropped', () => {
    // The booking records what was asked for; the snapshot has to agree with it,
    // or the contract shows a line the booking does not.
    const [line] = snapshot({ selectedExtrasDetails: ['mystery'] }).selectedExtras;
    expect(line).toMatchObject({ key: 'mystery', label: 'mystery', unitPrice: 0, lineTotal: 0, refId: '' });
  });

  test('an empty key is dropped entirely', () => {
    expect(snapshot({ selectedExtrasDetails: ['', '   '] }).selectedExtras).toEqual([]);
  });
});

describe('extras that arrive already priced', () => {
  // This is the shape createBooking passes: lines it built itself from the
  // catalog. The snapshot preserves them rather than re-deriving, so that the
  // snapshot and the booking cannot drift apart.
  const line = { key: 'gps', label: 'GPS', mode: 'perDay', unitPrice: 10, lineTotal: 30 };

  test('the supplied line total is preserved', () => {
    const [out] = snapshot({ selectedExtrasDetails: [line] }).selectedExtras;
    expect(out).toMatchObject({ unitPrice: 10, quantity: 3, lineTotal: 30 });
  });

  test('a supplied quantity is used instead of the day count', () => {
    const [out] = snapshot({ selectedExtrasDetails: [{ ...line, quantity: 2, lineTotal: undefined }] }).selectedExtras;
    expect(out).toMatchObject({ quantity: 2, lineTotal: 20 });
  });

  test('a quantity below one is floored at one', () => {
    // A zero-quantity line would be a line item that bills nothing while still
    // appearing on the contract.
    const [out] = snapshot({ selectedExtrasDetails: [{ ...line, quantity: 0, lineTotal: undefined }] }).selectedExtras;
    expect(out.quantity).toBe(1);
  });

  test('a per-booking line is billed once whatever quantity it carries', () => {
    const [out] = snapshot({ selectedExtrasDetails: [{ key: 'seat', mode: 'perBooking', unitPrice: 21, quantity: 9 }] }).selectedExtras;
    expect(out).toMatchObject({ quantity: 1, lineTotal: 21 });
  });

  test('billingMode is accepted as well as mode', () => {
    const [out] = snapshot({ selectedExtrasDetails: [{ key: 'seat', billingMode: 'perBooking', unitPrice: 21 }] }).selectedExtras;
    expect(out.billingMode).toBe('perBooking');
  });

  test('anything that is not perBooking is per-day', () => {
    const [out] = snapshot({ selectedExtrasDetails: [{ key: 'gps', mode: 'perFortnight', unitPrice: 10 }] }).selectedExtras;
    expect(out).toMatchObject({ billingMode: 'perDay', quantity: 3, lineTotal: 30 });
  });

  test('the catalog fills in what the line leaves out', () => {
    const [out] = snapshot({ selectedExtrasDetails: [{ key: 'seat' }] }).selectedExtras;
    expect(out).toMatchObject({ label: 'Baby seat', billingMode: 'perBooking', unitPrice: 21, lineTotal: 21, refId: 'x-seat' });
  });

  test('a line identified by id, value or name is still matched to the catalog', () => {
    for (const field of ['key', 'id', 'value', 'label', 'name']) {
      const [out] = snapshot({ selectedExtrasDetails: [{ [field]: 'gps' }] }).selectedExtras;
      expect(out.unitPrice).toBe(10);
    }
  });

  test('a line with neither key nor label is dropped', () => {
    expect(snapshot({ selectedExtrasDetails: [{ unitPrice: 99 }] }).selectedExtras).toEqual([]);
  });

  test('money is rounded to cents, not carried at full float precision', () => {
    const [out] = snapshot({ selectedExtrasDetails: [{ key: 'gps', unitPrice: 3.333, lineTotal: undefined }] }).selectedExtras;
    expect(out.unitPrice).toBe(3.33);
    expect(out.lineTotal).toBe(9.99);
  });
});

describe('where the extras list comes from', () => {
  test('the explicit argument wins over the booking', () => {
    const snap = snapshot({
      selectedExtrasDetails: ['gps'],
      booking: { billableDays: 3, basePricePerDay: 45, selectedExtrasDetails: ['seat'] },
    });
    expect(snap.selectedExtras.map((l) => l.key)).toEqual(['gps']);
  });

  test('the booking\'s detailed list is used when no argument is given', () => {
    const snap = snapshot({ booking: { billableDays: 3, basePricePerDay: 45, selectedExtrasDetails: ['seat'] } });
    expect(snap.selectedExtras.map((l) => l.key)).toEqual(['seat']);
  });

  test('the plain key list is the last resort', () => {
    const snap = snapshot({ booking: { billableDays: 3, basePricePerDay: 45, selectedExtras: ['gps'] } });
    expect(snap.selectedExtras.map((l) => l.key)).toEqual(['gps']);
  });

  test('no extras at all is an empty list, not a missing field', () => {
    expect(snapshot().selectedExtras).toEqual([]);
  });
});

describe('the insurance package', () => {
  test('is recorded with its catalog label and price', () => {
    expect(snapshot({ selectedPackage: 'cdw' }).selectedPackage)
      .toMatchObject({ key: 'cdw', label: 'CDW', pricePerDay: 12, refId: 'ins-cdw' });
  });

  test('is matched case-insensitively', () => {
    expect(snapshot({ selectedPackage: 'CDW' }).selectedPackage.key).toBe('cdw');
  });

  test('is matched even when the catalog row itself holds an upper-case key', () => {
    // Both sides are lowered before they meet. An admin typing "CDW" into the key
    // field would otherwise leave every booking on that plan priced at zero.
    const catalog = { ...CATALOG, insurancePlans: [{ _id: 'ins-cdw', key: 'CDW', label: 'CDW', pricePerDay: 12 }] };
    const snap = buildPricingSnapshot({ catalog, booking: { billableDays: 3 }, selectedPackage: 'cdw' });
    expect(snap.selectedPackage).toMatchObject({ label: 'CDW', pricePerDay: 12, refId: 'ins-cdw' });
  });

  test('falls back to price when the plan has no pricePerDay', () => {
    expect(snapshot({ selectedPackage: 'fdw' }).selectedPackage.pricePerDay).toBe(20);
  });

  test('an unknown package is labelled by its own key rather than left blank', () => {
    expect(snapshot({ selectedPackage: 'gold' }).selectedPackage).toMatchObject({ key: 'gold', label: 'GOLD', refId: '' });
  });

  test('no package at all leaves the label empty rather than reading UNDEFINED', () => {
    expect(snapshot().selectedPackage).toMatchObject({ key: '', label: '' });
  });
});

describe('the totals', () => {
  test('net and VAT add back up to the gross', () => {
    const { breakdown } = snapshot({ booking: { billableDays: 3, totalPrice: 165 } });
    expect(breakdown.gross).toBe(165);
    expect(Number((breakdown.net + breakdown.vat).toFixed(2))).toBe(165);
  });

  test('VAT is backed out of a gross figure, not added on top', () => {
    // 165 gross at 24% is 133.06 net, not 165 net plus 39.60.
    const { breakdown } = snapshot({ booking: { billableDays: 3, totalPrice: 165 } });
    expect(breakdown.net).toBe(133.06);
    expect(breakdown.vat).toBe(31.94);
  });

  test('a zero VAT rate leaves the gross untouched', () => {
    const catalog = { ...CATALOG, businessSettings: { ...CATALOG.businessSettings, vatRateDecimal: 0 } };
    const snap = buildPricingSnapshot({ catalog, booking: { billableDays: 3, totalPrice: 165 } });
    expect(snap.breakdown).toMatchObject({ gross: 165, net: 165, vat: 0 });
  });

  test('a negative VAT rate leaves the gross untouched too, rather than inflating the net', () => {
    // What the `vatRate > 0` guard is actually for: at exactly zero the division
    // would be harmless, but a negative rate stored on business settings would
    // otherwise produce a net larger than the gross, and at -1 a division by zero.
    const catalog = { ...CATALOG, businessSettings: { ...CATALOG.businessSettings, vatRateDecimal: -0.5 } };
    const snap = buildPricingSnapshot({ catalog, booking: { billableDays: 3, totalPrice: 165 } });
    expect(snap.breakdown).toMatchObject({ gross: 165, net: 165, vat: 0 });

    const atMinusOne = { ...CATALOG, businessSettings: { ...CATALOG.businessSettings, vatRateDecimal: -1 } };
    const snapAtMinusOne = buildPricingSnapshot({ catalog: atMinusOne, booking: { billableDays: 3, totalPrice: 165 } });
    expect(Number.isFinite(snapAtMinusOne.breakdown.net)).toBe(true);
    expect(snapAtMinusOne.breakdown.net).toBe(165);
  });

  test('the gross is summed from the parts when the booking has no total', () => {
    const snap = snapshot({
      booking: { billableDays: 3 },
      charges: { rental: 135, insurance: 36, options: 30, ageFee: 16, nightFee: 15, transport: 10, damages: 5, surcharges: 4 },
    });
    expect(snap.breakdown.gross).toBe(251);
  });

  test('a discount comes off the gross', () => {
    const snap = snapshot({ booking: { billableDays: 3 }, charges: { rental: 100, discount: 25 } });
    expect(snap.breakdown.gross).toBe(75);
  });

  test('every line of the breakdown is present even when nothing was charged', () => {
    // A missing key and a zero are different things to whatever reads this back.
    const { breakdown } = buildPricingSnapshot({ catalog: CATALOG, booking: {} });
    for (const key of ['rental', 'insurance', 'options', 'ageFee', 'nightFee', 'transport', 'damages', 'surcharges', 'discount', 'gross', 'net', 'vat']) {
      expect(breakdown[key]).toBe(0);
    }
  });

  test('the booking\'s own figures win over the charges argument', () => {
    const snap = snapshot({
      booking: { billableDays: 3, baseCost: 135, insuranceCost: 36, extrasTotal: 30 },
      charges: { rental: 1, insurance: 1, options: 1 },
    });
    expect(snap.breakdown).toMatchObject({ rental: 135, insurance: 36, options: 30 });
  });

  test('extras fall back to the sum of their own lines', () => {
    const snap = snapshot({ booking: { billableDays: 3 }, selectedExtrasDetails: ['gps', 'seat'] });
    expect(snap.breakdown.options).toBe(51);
  });

  test('the VAT rate falls back to the booking, then to 24%', () => {
    const catalog = { ...CATALOG, businessSettings: { currency: 'EUR' } };
    expect(buildPricingSnapshot({ catalog, booking: { billableDays: 1, vatRate: 0.13 } }).vatRate).toBe(0.13);
    expect(buildPricingSnapshot({ catalog, booking: { billableDays: 1 } }).vatRate).toBe(0.24);
  });
});

describe('the day count', () => {
  test('is taken from the booking when it has one', () => {
    expect(snapshot({ booking: { billableDays: 5 } }).billableDays).toBe(5);
  });

  test('is computed from the dates when the booking has none', () => {
    const snap = snapshot({ booking: { pickupDateTime: '2026-01-12T10:00:00Z', dropoffDateTime: '2026-01-15T10:00:00Z' } });
    expect(snap.billableDays).toBe(3);
  });

  test('is never less than one, so a per-day line always bills something', () => {
    expect(snapshot({ booking: { billableDays: 0 } }).billableDays).toBe(1);
    expect(snapshot({ booking: { billableDays: -4 } }).billableDays).toBe(1);
  });

  test('a per-day extra follows it', () => {
    const [line] = snapshot({ booking: { billableDays: 7 }, selectedExtrasDetails: ['gps'] }).selectedExtras;
    expect(line).toMatchObject({ quantity: 7, lineTotal: 70 });
  });
});

describe('the per-day rates written back', () => {
  test('are taken from the booking when it states them', () => {
    const snap = snapshot({ booking: { billableDays: 3, basePricePerDay: 45, insuranceExtraPerDay: 12 } });
    expect(snap).toMatchObject({ basePricePerDay: 45, insuranceExtraPerDay: 12 });
  });

  test('are derived from the totals when it does not', () => {
    const snap = snapshot({ booking: { billableDays: 3 }, charges: { rental: 135, insurance: 36 } });
    expect(snap).toMatchObject({ basePricePerDay: 45, insuranceExtraPerDay: 12 });
  });
});

describe('what the snapshot says about itself', () => {
  test('carries a schema version, so a later reader knows what it is holding', () => {
    expect(snapshot().schemaVersion).toBe(1);
  });

  test('records where it was built', () => {
    expect(snapshot({ source: 'createBooking' }).source).toBe('createBooking');
    expect(snapshot().source).toBe('booking-flow');
  });

  test('stamps a capture time, defaulting to now', () => {
    expect(snapshot({ capturedAt: '2026-01-12T10:00:00.000Z' }).capturedAt).toBe('2026-01-12T10:00:00.000Z');
    expect(Date.parse(snapshot().capturedAt)).not.toBeNaN();
  });

  test('records the currency, defaulting to EUR when the settings do not say', () => {
    expect(buildPricingSnapshot({ catalog: { businessSettings: {} }, booking: {} }).currency).toBe('EUR');
    expect(buildPricingSnapshot({ booking: {} }).currency).toBe('EUR');
    expect(buildPricingSnapshot({ catalog: { businessSettings: { currency: 'GBP' } }, booking: {} }).currency).toBe('GBP');
  });

  test('keeps the rental dates it was priced for', () => {
    const snap = snapshot({ booking: { billableDays: 3, pickupDateTime: '2026-01-12T10:00:00Z', dropoffDateTime: '2026-01-15T10:00:00Z' } });
    expect(snap.pickupDateTime).toBe('2026-01-12T10:00:00Z');
    expect(snap.dropoffDateTime).toBe('2026-01-15T10:00:00Z');
  });

  test('points back at the catalog rows it priced from', () => {
    const snap = snapshot({ selectedPackage: 'cdw', selectedExtrasDetails: ['gps', 'seat'] });
    expect(snap.refs).toEqual({
      businessSettingsId: 'bs-1',
      insurancePlanId: 'ins-cdw',
      extraServiceIds: ['x-gps', 'x-seat'],
    });
  });

  test('lists no reference for an extra that has no catalog row', () => {
    // An empty string in that list would look like a row that could be looked up.
    const snap = snapshot({ selectedExtrasDetails: ['gps', 'mystery'] });
    expect(snap.refs.extraServiceIds).toEqual(['x-gps']);
  });
});

describe('a snapshot built from nothing at all', () => {
  test('still has the shape a reader expects', () => {
    const snap = buildPricingSnapshot();
    expect(snap.schemaVersion).toBe(1);
    expect(snap.billableDays).toBe(1);
    expect(snap.selectedExtras).toEqual([]);
    expect(snap.breakdown.gross).toBe(0);
    expect(snap.refs.extraServiceIds).toEqual([]);
  });

  test('holds no NaN anywhere in its numbers', () => {
    // Every money field here is fed to a total or printed on a contract.
    const snap = buildPricingSnapshot({ booking: { billableDays: 'not a number', totalPrice: 'free' } });
    const numbers = JSON.stringify(snap).match(/-?\d+\.?\d*/g) || [];
    expect(numbers.every((n) => Number.isFinite(Number(n)))).toBe(true);
    expect(JSON.stringify(snap)).not.toContain('null,"net"');
    expect(Number.isFinite(snap.breakdown.gross)).toBe(true);
    expect(Number.isFinite(snap.breakdown.net)).toBe(true);
    expect(Number.isFinite(snap.breakdown.vat)).toBe(true);
  });
});
