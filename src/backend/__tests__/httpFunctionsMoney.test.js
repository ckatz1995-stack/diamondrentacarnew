// The money coercion inside http-functions is inline in a request handler, so this
// exercises the same expression shape rather than importing the handler itself.
// It exists to pin the distinction that caused the bug: `??` guards null/undefined,
// it does not guard NaN.

function toFinite(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

describe('money coercion for the public booking endpoint', () => {
  test('?? does not catch NaN — the reason the guard was needed', () => {
    const billableDays = 3;
    const junk = { basePricePerDay: 'not-a-number' };
    const oldWay = Number(undefined ?? junk.baseCost ?? ((Number(junk.basePricePerDay || 0)) * billableDays) ?? 0);
    expect(Number.isNaN(oldWay)).toBe(true);
  });

  test('toFinite turns a non-numeric rate into zero rather than NaN', () => {
    const billableDays = 3;
    const junk = { basePricePerDay: 'not-a-number' };
    const newWay = toFinite(undefined ?? junk.baseCost ?? ((Number(junk.basePricePerDay || 0)) * billableDays));
    expect(newWay).toBe(0);
  });

  test('a NaN component would have poisoned the whole recomputed total', () => {
    // This is what made it worth fixing: one bad field makes every downstream
    // figure NaN, and the endpoint reports NaN rather than a price.
    const parts = [NaN, 36, 5, 16, 15, 0, 0, 0];
    const total = Number(parts.reduce((a, b) => a + b, 0).toFixed(2));
    expect(Number.isNaN(total)).toBe(true);

    const guarded = Number(parts.map((p) => toFinite(p)).reduce((a, b) => a + b, 0).toFixed(2));
    expect(guarded).toBe(72);
  });

  test('preserves ordinary values untouched', () => {
    expect(toFinite(135)).toBe(135);
    expect(toFinite(0)).toBe(0);
    expect(toFinite('42.5')).toBe(42.5);
  });
});
