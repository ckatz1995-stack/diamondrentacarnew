import { bookingsOverlap } from '../availability.js';

const d = (iso) => new Date(iso);

describe('bookingsOverlap', () => {
  test('detects a partial overlap', () => {
    expect(bookingsOverlap(
      d('2026-01-01T10:00:00Z'), d('2026-01-05T10:00:00Z'),
      d('2026-01-03T10:00:00Z'), d('2026-01-07T10:00:00Z'),
    )).toBe(true);
  });

  test('detects one booking fully containing another', () => {
    expect(bookingsOverlap(
      d('2026-01-01T00:00:00Z'), d('2026-01-10T00:00:00Z'),
      d('2026-01-03T00:00:00Z'), d('2026-01-04T00:00:00Z'),
    )).toBe(true);
  });

  test('treats identical ranges as overlapping', () => {
    expect(bookingsOverlap(
      d('2026-01-01T00:00:00Z'), d('2026-01-05T00:00:00Z'),
      d('2026-01-01T00:00:00Z'), d('2026-01-05T00:00:00Z'),
    )).toBe(true);
  });

  test('does not treat back-to-back bookings as overlapping', () => {
    // The handover case: one rental ends exactly when the next begins. Intervals
    // are half-open, so the same vehicle can serve both.
    expect(bookingsOverlap(
      d('2026-01-01T10:00:00Z'), d('2026-01-05T10:00:00Z'),
      d('2026-01-05T10:00:00Z'), d('2026-01-09T10:00:00Z'),
    )).toBe(false);
  });

  test('does not treat back-to-back bookings as overlapping in either order', () => {
    expect(bookingsOverlap(
      d('2026-01-05T10:00:00Z'), d('2026-01-09T10:00:00Z'),
      d('2026-01-01T10:00:00Z'), d('2026-01-05T10:00:00Z'),
    )).toBe(false);
  });

  test('returns false for clearly disjoint ranges', () => {
    expect(bookingsOverlap(
      d('2026-01-01T00:00:00Z'), d('2026-01-02T00:00:00Z'),
      d('2026-03-01T00:00:00Z'), d('2026-03-02T00:00:00Z'),
    )).toBe(false);
  });

  test('detects a one-millisecond overlap', () => {
    expect(bookingsOverlap(
      d('2026-01-01T10:00:00.000Z'), d('2026-01-05T10:00:00.001Z'),
      d('2026-01-05T10:00:00.000Z'), d('2026-01-09T10:00:00.000Z'),
    )).toBe(true);
  });

  test('is symmetric in its two intervals', () => {
    const a = [d('2026-01-01T10:00:00Z'), d('2026-01-05T10:00:00Z')];
    const b = [d('2026-01-03T10:00:00Z'), d('2026-01-07T10:00:00Z')];
    expect(bookingsOverlap(...a, ...b)).toBe(bookingsOverlap(...b, ...a));
  });

  test('counts a zero-length booking strictly inside another as overlapping', () => {
    const instant = d('2026-01-03T00:00:00Z');
    expect(bookingsOverlap(
      d('2026-01-01T00:00:00Z'), d('2026-01-05T00:00:00Z'),
      instant, instant,
    )).toBe(true);
  });

  test('does not count a zero-length booking at the exact end boundary', () => {
    const instant = d('2026-01-05T00:00:00Z');
    expect(bookingsOverlap(
      d('2026-01-01T00:00:00Z'), d('2026-01-05T00:00:00Z'),
      instant, instant,
    )).toBe(false);
  });

  test('accepts ISO strings as well as Date objects', () => {
    expect(bookingsOverlap(
      '2026-01-01T10:00:00Z', '2026-01-05T10:00:00Z',
      '2026-01-03T10:00:00Z', '2026-01-07T10:00:00Z',
    )).toBe(true);
  });

  test('returns false when any date is missing or invalid', () => {
    const a = d('2026-01-01T00:00:00Z');
    const b = d('2026-01-05T00:00:00Z');
    expect(bookingsOverlap(null, b, a, b)).toBe(false);
    expect(bookingsOverlap(a, undefined, a, b)).toBe(false);
    expect(bookingsOverlap(a, b, 'not-a-date', b)).toBe(false);
    expect(bookingsOverlap(a, b, a, new Date('nope'))).toBe(false);
  });
});
