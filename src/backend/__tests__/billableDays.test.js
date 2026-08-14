import { computeBillableDaysDetailed, computeBillableDays } from '../billableDays.js';

describe('computeBillableDaysDetailed', () => {
  test('computes hours and rounds up partial days for a multi-day rental', () => {
    const pickup = new Date('2026-01-01T10:00:00Z');
    const dropoff = new Date('2026-01-03T12:00:00Z');
    const result = computeBillableDaysDetailed(pickup, dropoff);
    expect(result.hours).toBe(50);
    expect(result.billableDays).toBe(3);
  });

  test('rounds a same-day rental up to at least 1 billable day', () => {
    const pickup = new Date('2026-01-01T10:00:00Z');
    const dropoff = new Date('2026-01-01T14:00:00Z');
    const result = computeBillableDaysDetailed(pickup, dropoff);
    expect(result.hours).toBe(4);
    expect(result.billableDays).toBe(1);
  });

  test('falls back to fallbackDays when dropoff equals pickup', () => {
    const pickup = new Date('2026-01-01T10:00:00Z');
    const result = computeBillableDaysDetailed(pickup, pickup, 2);
    expect(result).toEqual({ hours: 0, billableDays: 2 });
  });

  test('falls back to fallbackDays when dropoff is before pickup', () => {
    const pickup = new Date('2026-01-05T10:00:00Z');
    const dropoff = new Date('2026-01-01T10:00:00Z');
    const result = computeBillableDaysDetailed(pickup, dropoff, 3);
    expect(result).toEqual({ hours: 0, billableDays: 3 });
  });

  test('falls back to fallbackDays when dates are invalid', () => {
    const result = computeBillableDaysDetailed('not-a-date', 'also-not-a-date', 2);
    expect(result).toEqual({ hours: 0, billableDays: 2 });
  });

  test('falls back to fallbackDays when dates are missing', () => {
    const result = computeBillableDaysDetailed(null, null, 4);
    expect(result).toEqual({ hours: 0, billableDays: 4 });
  });

  test('coerces a non-finite fallbackDays down to the minimum of 1', () => {
    const pickup = new Date('2026-01-01T10:00:00Z');
    const result = computeBillableDaysDetailed(pickup, pickup, NaN);
    expect(result.billableDays).toBe(1);
  });

  test('never returns fewer than 1 billable day even for a fallbackDays of 0', () => {
    const pickup = new Date('2026-01-01T10:00:00Z');
    const result = computeBillableDaysDetailed(pickup, pickup, 0);
    expect(result.billableDays).toBe(1);
  });
});

describe('computeBillableDays', () => {
  test('returns just the billableDays number', () => {
    const pickup = new Date('2026-01-01T00:00:00Z');
    const dropoff = new Date('2026-01-02T01:00:00Z');
    expect(computeBillableDays(pickup, dropoff)).toBe(2);
  });
});
