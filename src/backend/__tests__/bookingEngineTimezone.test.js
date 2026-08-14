import {
  getTimeZoneOffsetMs,
  parseBusinessLocalDateTime,
  athensHour,
  isNightShift,
} from '../bookingEngine.jsw';

const HOUR_MS = 60 * 60 * 1000;

// Athens is UTC+2 in winter (EET) and UTC+3 in summer (EEST). In 2026 the
// transitions are 29 March (03:00 local -> 04:00) and 25 October (04:00 -> 03:00).
const WINTER_INSTANT = new Date('2026-01-15T00:00:00Z');
const SUMMER_INSTANT = new Date('2026-07-15T00:00:00Z');

// Reads a UTC instant back as Athens wall-clock text, so round-trip assertions
// state the property that actually matters rather than a precomputed offset.
function athensWallClock(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Athens',
    dateStyle: 'short',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(date);
}

describe('getTimeZoneOffsetMs', () => {
  test('reports +2h for Athens in winter', () => {
    expect(getTimeZoneOffsetMs(WINTER_INSTANT)).toBe(2 * HOUR_MS);
  });

  test('reports +3h for Athens in summer', () => {
    expect(getTimeZoneOffsetMs(SUMMER_INSTANT)).toBe(3 * HOUR_MS);
  });

  test('honours an explicitly passed time zone', () => {
    expect(getTimeZoneOffsetMs(WINTER_INSTANT, 'UTC')).toBe(0);
  });
});

describe('parseBusinessLocalDateTime — basic parsing', () => {
  test('reads a winter wall-clock string as Athens local time', () => {
    const parsed = parseBusinessLocalDateTime('2026-01-15T10:00');
    expect(parsed.toISOString()).toBe('2026-01-15T08:00:00.000Z');
    expect(athensWallClock(parsed)).toBe('15/01/2026, 10:00');
  });

  test('reads a summer wall-clock string as Athens local time', () => {
    const parsed = parseBusinessLocalDateTime('2026-07-15T10:00');
    expect(parsed.toISOString()).toBe('2026-07-15T07:00:00.000Z');
    expect(athensWallClock(parsed)).toBe('15/07/2026, 10:00');
  });

  test('accepts a space separator and optional seconds', () => {
    expect(parseBusinessLocalDateTime('2026-01-15 10:00:30').toISOString())
      .toBe('2026-01-15T08:00:30.000Z');
  });

  test('passes a Date through unchanged', () => {
    const input = new Date('2026-01-15T08:00:00Z');
    expect(parseBusinessLocalDateTime(input)).toBe(input);
  });

  test('returns null for empty, null and undefined input', () => {
    expect(parseBusinessLocalDateTime('')).toBeNull();
    expect(parseBusinessLocalDateTime(null)).toBeNull();
    expect(parseBusinessLocalDateTime(undefined)).toBeNull();
  });

  test('returns null for an unparseable string', () => {
    expect(parseBusinessLocalDateTime('not-a-date')).toBeNull();
    expect(parseBusinessLocalDateTime(new Date('nope'))).toBeNull();
  });
});

describe('parseBusinessLocalDateTime — DST correctness', () => {
  // These are the cases the two-step offset correction exists for: the offset
  // sampled at the naive UTC guess differs from the offset at the corrected
  // instant, so a single-step conversion lands an hour off.
  test('resolves a local time just before the spring-forward transition', () => {
    const parsed = parseBusinessLocalDateTime('2026-03-29T01:00');
    expect(parsed.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(athensWallClock(parsed)).toBe('29/03/2026, 01:00');
  });

  test('resolves a local time inside the hour before the clocks jump', () => {
    const parsed = parseBusinessLocalDateTime('2026-03-29T02:30');
    expect(parsed.toISOString()).toBe('2026-03-29T00:30:00.000Z');
    expect(athensWallClock(parsed)).toBe('29/03/2026, 02:30');
  });

  test('resolves a local time just after the spring-forward transition', () => {
    const parsed = parseBusinessLocalDateTime('2026-03-29T04:00');
    expect(parsed.toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect(athensWallClock(parsed)).toBe('29/03/2026, 04:00');
  });

  test('shifts a nonexistent spring-forward local time forward past the gap', () => {
    // 03:00-03:59 does not exist on 29 March 2026 — the clocks go 03:00 -> 04:00.
    // Documents the chosen resolution: the instant lands after the gap.
    const parsed = parseBusinessLocalDateTime('2026-03-29T03:30');
    expect(parsed.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(athensWallClock(parsed)).toBe('29/03/2026, 04:30');
  });

  test('resolves the ambiguous autumn hour to the post-transition (EET) reading', () => {
    // 03:30 occurs twice on 25 October 2026: once at 00:30Z (EEST, +3) and again
    // at 01:30Z (EET, +2). Pins which one the parser picks.
    const parsed = parseBusinessLocalDateTime('2026-10-25T03:30');
    expect(parsed.toISOString()).toBe('2026-10-25T01:30:00.000Z');
    expect(athensWallClock(parsed)).toBe('25/10/2026, 03:30');
  });

  test('resolves a local time after the autumn transition', () => {
    const parsed = parseBusinessLocalDateTime('2026-10-25T05:00');
    expect(parsed.toISOString()).toBe('2026-10-25T03:00:00.000Z');
    expect(athensWallClock(parsed)).toBe('25/10/2026, 05:00');
  });

  test('round-trips wall-clock times on both sides of every 2026 transition', () => {
    const inputs = [
      '2026-01-15T10:00',
      '2026-03-28T12:00',
      '2026-03-29T12:00',
      '2026-07-15T10:00',
      '2026-10-24T12:00',
      '2026-10-26T12:00',
      '2026-12-31T23:59',
    ];
    for (const input of inputs) {
      const parsed = parseBusinessLocalDateTime(input);
      const [date, time] = input.split('T');
      const [yy, mm, dd] = date.split('-');
      expect(athensWallClock(parsed)).toBe(`${dd}/${mm}/${yy}, ${time}`);
    }
  });
});

describe('athensHour', () => {
  test('converts a UTC instant to the Athens hour in winter (+2)', () => {
    expect(athensHour(new Date('2026-01-15T08:30:00Z'))).toEqual({ hour: 10, minute: 30 });
  });

  test('converts a UTC instant to the Athens hour in summer (+3)', () => {
    expect(athensHour(new Date('2026-07-15T08:30:00Z'))).toEqual({ hour: 11, minute: 30 });
  });

  test('uses a 24-hour clock rather than wrapping at noon', () => {
    expect(athensHour(new Date('2026-01-15T20:00:00Z')).hour).toBe(22);
  });
});

describe('isNightShift', () => {
  // Night is hour < 8 || hour >= 22 in Athens local time.
  test('treats 07:59 Athens as night', () => {
    expect(isNightShift(new Date('2026-01-15T05:59:00Z'))).toBe(true);
  });

  test('treats 08:00 Athens as daytime', () => {
    expect(isNightShift(new Date('2026-01-15T06:00:00Z'))).toBe(false);
  });

  test('treats 21:59 Athens as daytime', () => {
    expect(isNightShift(new Date('2026-01-15T19:59:00Z'))).toBe(false);
  });

  test('treats 22:00 Athens as night', () => {
    expect(isNightShift(new Date('2026-01-15T20:00:00Z'))).toBe(true);
  });

  test('applies the boundary in Athens time, not UTC, during summer', () => {
    // 21:30 UTC is 00:30 Athens the next day — night, though the UTC hour is not.
    expect(isNightShift(new Date('2026-07-15T21:30:00Z'))).toBe(true);
    // 05:30 UTC is 08:30 Athens — daytime, though the UTC hour would read as night.
    expect(isNightShift(new Date('2026-07-15T05:30:00Z'))).toBe(false);
  });

  test('returns false for invalid or non-Date input', () => {
    expect(isNightShift(new Date('nope'))).toBe(false);
    expect(isNightShift('2026-01-15T20:00:00Z')).toBe(false);
    expect(isNightShift(null)).toBe(false);
  });
});
