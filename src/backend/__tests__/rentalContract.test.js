import {
  computeVatBreakdown,
  billableDaysFromBooking,
  deriveChargeLines,
  buildChargeLinesFromCharges,
  normalizeChargeLinesPayload,
  escapeHtml,
} from '../rentalContract.jsw';

describe('billableDaysFromBooking', () => {
  test('rounds partial days up', () => {
    expect(billableDaysFromBooking({
      pickupDateTime: '2026-01-01T10:00:00Z',
      dropoffDateTime: '2026-01-03T12:00:00Z',
    })).toBe(3);
  });

  test('charges at least one day for a short same-day rental', () => {
    expect(billableDaysFromBooking({
      pickupDateTime: '2026-01-01T10:00:00Z',
      dropoffDateTime: '2026-01-01T12:00:00Z',
    })).toBe(1);
  });

  test('falls back to one day when dates are missing or invalid', () => {
    expect(billableDaysFromBooking({})).toBe(1);
    expect(billableDaysFromBooking({ pickupDateTime: 'nope', dropoffDateTime: 'nope' })).toBe(1);
    expect(billableDaysFromBooking()).toBe(1);
  });

  test('never returns a negative day count for a reversed range', () => {
    expect(billableDaysFromBooking({
      pickupDateTime: '2026-01-05T10:00:00Z',
      dropoffDateTime: '2026-01-01T10:00:00Z',
    })).toBe(1);
  });
});

describe('computeVatBreakdown', () => {
  test('back-calculates VAT from a VAT-inclusive gross', () => {
    // Same convention as computeBookingTotals: the gross already contains the VAT.
    expect(computeVatBreakdown(124, 0.24)).toEqual({ gross: 124, net: 100, vat: 24, vatRate: 0.24 });
  });

  test('splits the gross exactly, so net + VAT is what the customer pays', () => {
    for (const gross of [0.05, 1, 33.33, 99.99, 123.45, 1000, 4321.09]) {
      const { net, vat } = computeVatBreakdown(gross, 0.24);
      expect(Number((net + vat).toFixed(2))).toBe(gross);
    }
  });

  test('treats the whole amount as net when the rate is zero', () => {
    expect(computeVatBreakdown(100, 0)).toEqual({ gross: 100, net: 100, vat: 0, vatRate: 0 });
  });

  test('treats the whole amount as net for a negative rate rather than inventing VAT', () => {
    expect(computeVatBreakdown(100, -0.1)).toMatchObject({ net: 100, vat: 0 });
  });

  test('handles a zero or negative gross without dividing anything', () => {
    expect(computeVatBreakdown(0, 0.24)).toMatchObject({ gross: 0, net: 0, vat: 0 });
    expect(computeVatBreakdown(-50, 0.24)).toMatchObject({ net: -50, vat: 0 });
  });

  test('coerces non-numeric input to zero rather than producing NaN', () => {
    const result = computeVatBreakdown('not-a-number', 0.24);
    expect(Number.isNaN(result.net)).toBe(false);
    expect(result.net).toBe(0);
  });
});

describe('deriveChargeLines', () => {
  const dates = {
    pickupDateTime: '2026-01-01T10:00:00Z',
    dropoffDateTime: '2026-01-04T10:00:00Z', // 3 days
  };

  test('prefers stored booking totals over the charges payload', () => {
    const lines = deriveChargeLines(
      { ...dates, baseCost: 150, insuranceCost: 36, extrasTotal: 15, ageFee: 16, nightFee: 15 },
      { rental: 999, insurance: 999, options: 999, ageFee: 999, nightFee: 999 },
    );
    expect(lines).toMatchObject({ rental: 150, insurance: 36, options: 15, ageFee: 16, nightFee: 15 });
  });

  test('falls back to per-day rates times billable days when the booking has no totals', () => {
    const lines = deriveChargeLines(
      { ...dates, basePricePerDay: 50, insuranceExtraPerDay: 12 },
      {},
    );
    expect(lines.days).toBe(3);
    expect(lines.rental).toBe(150);
    expect(lines.insurance).toBe(36);
  });

  test('falls back to the charges payload before the per-day calculation', () => {
    const lines = deriveChargeLines({ ...dates, basePricePerDay: 50 }, { rental: 120 });
    expect(lines.rental).toBe(120);
  });

  test('subtracts discount from the gross while other lines add', () => {
    const lines = deriveChargeLines(
      { ...dates, baseCost: 100, insuranceCost: 0, extrasTotal: 0, ageFee: 0, nightFee: 0 },
      { transport: 20, damages: 10, surcharges: 5, discount: 15 },
    );
    expect(lines.gross).toBe(120);
  });

  test('rounds the gross to two decimals', () => {
    const lines = deriveChargeLines(
      { ...dates, baseCost: 33.333, insuranceCost: 33.333, extrasTotal: 33.333, ageFee: 0, nightFee: 0 },
      {},
    );
    expect(lines.gross).toBe(100);
  });

  test('treats a zero stored total as a real value, not a missing one', () => {
    // 0 is finite, so it must win over the per-day fallback — otherwise a
    // deliberately zeroed line would silently be re-derived and re-charged.
    const lines = deriveChargeLines({ ...dates, baseCost: 0, basePricePerDay: 50 }, {});
    expect(lines.rental).toBe(0);
  });

  test('produces a zero gross for an empty booking rather than NaN', () => {
    const lines = deriveChargeLines({}, {});
    expect(lines.gross).toBe(0);
    expect(Number.isNaN(lines.gross)).toBe(false);
  });
});

describe('buildChargeLinesFromCharges', () => {
  test('emits a line per non-zero charge, and always keeps discount', () => {
    const lines = buildChargeLinesFromCharges({ rental: 150, insurance: 0, discount: 0 });
    const codes = lines.map((l) => l.code);
    expect(codes).toContain('rental_base');
    expect(codes).toContain('discount');
    expect(codes).not.toContain('insurance');
  });

  test('stores discount as a negative amount', () => {
    const [discount] = buildChargeLinesFromCharges({ discount: 25 }).filter((l) => l.code === 'discount');
    expect(discount.amount).toBe(-25);
    expect(discount.absAmount).toBe(25);
    expect(discount.sign).toBe(-1);
  });

  test('normalises a negative input for an additive line to a positive amount', () => {
    const [rental] = buildChargeLinesFromCharges({ rental: -150 }).filter((l) => l.code === 'rental_base');
    expect(rental.amount).toBe(150);
  });

  test('preserves editable labels and notes from existing lines', () => {
    const existing = [{ code: 'rental_base', label: 'Custom label', notes: 'agreed by phone', order: 5 }];
    const [rental] = buildChargeLinesFromCharges({ rental: 150 }, existing).filter((l) => l.code === 'rental_base');
    expect(rental.label).toBe('Custom label');
    expect(rental.notes).toBe('agreed by phone');
    expect(rental.order).toBe(5);
  });

  test('marks derived lines as derived and manual lines as manual', () => {
    const lines = buildChargeLinesFromCharges({ rental: 100, transport: 20 });
    expect(lines.find((l) => l.code === 'rental_base').derived).toBe(true);
    expect(lines.find((l) => l.code === 'transport_fee').derived).toBe(false);
  });
});

describe('normalizeChargeLinesPayload', () => {
  test('drops entries that are not objects', () => {
    const rows = normalizeChargeLinesPayload([null, 'nope', 42, { code: 'rental_base', amount: 10 }]);
    expect(rows.filter(Boolean)).toHaveLength(1);
  });

  test('returns an empty list for non-array input', () => {
    expect(normalizeChargeLinesPayload(null)).toEqual([]);
    expect(normalizeChargeLinesPayload(undefined)).toEqual([]);
  });

  test('infers a negative sign for a discount line', () => {
    const [row] = normalizeChargeLinesPayload([{ code: 'discount', amount: 20 }]);
    expect(row.sign).toBe(-1);
  });
});

describe('escapeHtml', () => {
  // Contract documents are rendered to HTML from customer-supplied fields, so
  // this is the boundary that stops a name or note from injecting markup.
  test('escapes the five HTML-significant characters', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('say "hi"')).toBe('say &quot;hi&quot;');
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  test('escapes ampersands before the other entities, so output is not double-escaped', () => {
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  test('neutralises a script payload hidden in a customer field', () => {
    const out = escapeHtml('"><script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('">');
  });

  test('coerces null and undefined to an empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});
