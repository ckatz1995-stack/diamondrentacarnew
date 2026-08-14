import { computeBookingTotals } from '../bookingTotals.js';

describe('computeBookingTotals — summing components', () => {
  test('adds every priced component into the total', () => {
    const result = computeBookingTotals({
      baseCost: 200,
      insuranceCost: 60,
      extrasCost: 25,
      ageFee: 16,
      nightFee: 30,
      locationFee: 10,
      vatRateDecimal: 0,
    });
    expect(result.totalPrice).toBe(341);
  });

  test('defaults every component to zero', () => {
    const result = computeBookingTotals();
    expect(result).toMatchObject({
      baseCost: 0,
      insuranceCost: 0,
      extrasCost: 0,
      ageFee: 0,
      nightFee: 0,
      locationFee: 0,
      totalPrice: 0,
      netAmount: 0,
      vatAmount: 0,
    });
  });

  test('echoes each rounded component back alongside the total', () => {
    const result = computeBookingTotals({ baseCost: 200.014, insuranceCost: 60.006 });
    expect(result.baseCost).toBe(200.01);
    expect(result.insuranceCost).toBe(60.01);
  });

  test('rounds exact half-cents down, matching JS toFixed', () => {
    // Documents a pre-existing quirk carried over from the inline calculation:
    // 200.005 is really 200.00499999999999545 in binary floating point, so
    // toFixed(2) rounds it down rather than up. Components arrive already
    // rounded to 2dp in practice, so this is a documented edge, not a live bug.
    expect(computeBookingTotals({ baseCost: 200.005 }).baseCost).toBe(200);
  });

  test('ignores non-numeric component values rather than producing NaN', () => {
    const result = computeBookingTotals({
      baseCost: 200,
      insuranceCost: 'not-a-number',
      extrasCost: undefined,
      ageFee: null,
      vatRateDecimal: 0,
    });
    expect(result.totalPrice).toBe(200);
    expect(Number.isNaN(result.totalPrice)).toBe(false);
  });
});

describe('computeBookingTotals — VAT back-calculation', () => {
  test('treats component prices as VAT-inclusive', () => {
    // 124.00 gross at 24% is 100.00 net + 24.00 VAT — NOT 124 + 29.76.
    const result = computeBookingTotals({ baseCost: 124, vatRateDecimal: 0.24 });
    expect(result.totalPrice).toBe(124);
    expect(result.netAmount).toBe(100);
    expect(result.vatAmount).toBe(24);
  });

  test('always splits the gross exactly, with no rounding drift', () => {
    // The pairing that matters: net + VAT must equal the amount charged.
    for (const baseCost of [0.01, 1, 33.33, 99.99, 123.45, 1000, 4321.09]) {
      const { totalPrice, netAmount, vatAmount } = computeBookingTotals({ baseCost, vatRateDecimal: 0.24 });
      expect(Number((netAmount + vatAmount).toFixed(2))).toBe(totalPrice);
    }
  });

  test('leaves the total as net when the VAT rate is zero', () => {
    const result = computeBookingTotals({ baseCost: 100, vatRateDecimal: 0 });
    expect(result.netAmount).toBe(100);
    expect(result.vatAmount).toBe(0);
  });

  test('treats a missing or non-numeric VAT rate as zero rather than NaN', () => {
    expect(computeBookingTotals({ baseCost: 100 }).netAmount).toBe(100);
    expect(computeBookingTotals({ baseCost: 100, vatRateDecimal: 'x' }).netAmount).toBe(100);
  });

  test('handles a rate expressed as a decimal fraction, not a percentage', () => {
    // Guards against passing 24 instead of 0.24, which would yield a 4.00 net.
    const asFraction = computeBookingTotals({ baseCost: 124, vatRateDecimal: 0.24 });
    const asPercent = computeBookingTotals({ baseCost: 124, vatRateDecimal: 24 });
    expect(asFraction.netAmount).toBe(100);
    expect(asPercent.netAmount).toBe(4.96);
  });

  test('does not divide by zero when the rate is -1', () => {
    const result = computeBookingTotals({ baseCost: 100, vatRateDecimal: -1 });
    expect(Number.isFinite(result.netAmount)).toBe(true);
    expect(result.netAmount).toBe(100);
    expect(result.vatAmount).toBe(0);
  });

  test('reproduces the full inline calculation createBooking previously did', () => {
    // 3 days at 45/day, insurance 12/day, one 5.00 perBooking extra,
    // 19-22 age fee, one night pickup, and a 10.00 pickup location fee.
    const result = computeBookingTotals({
      baseCost: 135,
      insuranceCost: 36,
      extrasCost: 5,
      ageFee: 16,
      nightFee: 15,
      locationFee: 10,
      vatRateDecimal: 0.24,
    });
    expect(result.totalPrice).toBe(217);
    expect(result.netAmount).toBe(175);
    expect(result.vatAmount).toBe(42);
  });
});
