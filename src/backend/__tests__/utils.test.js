import { addDays, addHours, asDate, extractCode, isLikelyId, normalizeDateParam, pickLabel, safeNum, safeText } from '../utils.js';

// Shared coercion helpers. These are small enough to look obviously correct,
// which is exactly why they are worth pinning: safeText and addDays each have a
// sharp edge that produced a live bug in dailyOps, and neither threw.

describe('safeText', () => {
  test.each([
    ['a string', 'hello', 'hello'],
    ['surrounding whitespace', '  hello  ', 'hello'],
    ['null', null, ''],
    ['undefined', undefined, ''],
    ['a number', 42, '42'],
    ['zero', 0, '0'],
  ])('%s', (_label, input, expected) => {
    expect(safeText(input)).toBe(expected);
  });

  test('stringifies booleans, so its result is truthy for false', () => {
    // This is the sharp edge. `if (safeText(someBoolean))` is true either way,
    // which made every daily-ops request read as "vehicle blocked". Booleans
    // must be tested directly, not through safeText.
    expect(safeText(false)).toBe('false');
    expect(!!safeText(false)).toBe(true);
    expect(safeText(true)).toBe('true');
  });
});

describe('safeNum', () => {
  test.each([
    ['a number', 42, 42],
    ['a numeric string', '42.5', 42.5],
    ['a non-numeric string', 'abc', 0],
    ['null', null, 0],
    ['undefined', undefined, 0],
    ['Infinity', Infinity, 0],
    ['NaN', NaN, 0],
  ])('%s', (_label, input, expected) => {
    expect(safeNum(input)).toBe(expected);
  });

  test('an explicit fallback replaces the default zero', () => {
    expect(safeNum('abc', -1)).toBe(-1);
  });
});

describe('asDate', () => {
  test('parses an ISO string', () => {
    expect(asDate('2026-03-10T09:00:00.000Z').toISOString()).toBe('2026-03-10T09:00:00.000Z');
  });

  test('passes a Date through', () => {
    const d = new Date('2026-03-10T09:00:00.000Z');
    expect(asDate(d).getTime()).toBe(d.getTime());
  });

  test.each([['null', null], ['undefined', undefined], ['an empty string', ''], ['nonsense', 'not-a-date']])(
    'returns null for %s', (_label, input) => {
      expect(asDate(input)).toBeNull();
    },
  );
});

describe('addHours', () => {
  const base = new Date('2026-03-10T12:00:00.000Z');

  test('adds whole hours', () => {
    expect(addHours(base, 2).toISOString()).toBe('2026-03-10T14:00:00.000Z');
  });

  test('adds fractional hours exactly', () => {
    // The reason this helper exists. Date#setHours truncates, so the obvious
    // implementation would return `base` unchanged here.
    expect(addHours(base, 0.5).toISOString()).toBe('2026-03-10T12:30:00.000Z');
    expect(addHours(base, 1.25).toISOString()).toBe('2026-03-10T13:15:00.000Z');
  });

  test('goes backwards for a negative offset', () => {
    expect(addHours(base, -3).toISOString()).toBe('2026-03-10T09:00:00.000Z');
  });

  test('rolls over a day boundary', () => {
    expect(addHours(base, 14).toISOString()).toBe('2026-03-11T02:00:00.000Z');
  });

  test('does not mutate the date it was given', () => {
    const original = base.getTime();
    addHours(base, 5);
    expect(base.getTime()).toBe(original);
  });

  test.each([['null', null], ['undefined', undefined], ['nonsense', 'abc']])(
    'treats %s hours as zero rather than producing an invalid date', (_label, input) => {
      expect(addHours(base, input).toISOString()).toBe(base.toISOString());
    },
  );
});

describe('addDays', () => {
  const base = new Date('2026-03-10T12:00:00.000Z');

  test('adds whole days', () => {
    expect(addDays(base, 2).toISOString()).toBe('2026-03-12T12:00:00.000Z');
  });

  test('goes backwards for a negative offset', () => {
    expect(addDays(base, -10).toISOString()).toBe('2026-02-28T12:00:00.000Z');
  });

  test('truncates a fractional argument to nothing', () => {
    // Not a bug to fix here — addDays is calendar-based on purpose, because
    // adding a day across a DST boundary is not the same as adding 24 hours.
    // It is pinned so the limitation is documented rather than rediscovered:
    // sub-day offsets belong in addHours.
    expect(addDays(base, 2 / 24).toISOString()).toBe(base.toISOString());
    expect(addDays(base, 0.9).toISOString()).toBe(base.toISOString());
  });

  test('does not mutate the date it was given', () => {
    const original = base.getTime();
    addDays(base, 5);
    expect(base.getTime()).toBe(original);
  });
});

describe('pickLabel', () => {
  test.each([
    ['a plain string', 'Athens Airport', 'Athens Airport'],
    ['an object with a label', { label: 'Athens Airport' }, 'Athens Airport'],
    ['an object with a title', { title: 'Athens Airport' }, 'Athens Airport'],
    ['an empty value', '', ''],
    ['null', null, ''],
  ])('%s', (_label, input, expected) => {
    expect(pickLabel(input)).toBe(expected);
  });

  test('prefers label over the other keys', () => {
    expect(pickLabel({ label: 'Label', title: 'Title', name: 'Name' })).toBe('Label');
  });
});

describe('isLikelyId', () => {
  test.each([
    ['a uuid', '3f1a2b4c-9d8e-4f0a-b1c2-d3e4f5a6b7c8', true],
    ['a long opaque key', 'abcdef0123456789abcdef01', true],
    ['a category code', 'ECO', false],
    ['a human label', 'Economy', false],
    ['an empty string', '', false],
  ])('%s', (_label, input, expected) => {
    expect(isLikelyId(input)).toBe(expected);
  });
});

describe('extractCode', () => {
  test.each([
    ['a code and label pair', 'ECO - Economy', 'ECO'],
    ['a bare code', 'ECO', 'ECO'],
    ['a label with no separator', 'Economy Class', 'Economy'],
    ['an empty value', '', ''],
  ])('%s', (_label, input, expected) => {
    expect(extractCode(input)).toBe(expected);
  });

  test('refuses to read a code out of an id', () => {
    // An id is not a category. Returning its first characters would silently
    // group unrelated vehicles together.
    expect(extractCode('3f1a2b4c-9d8e-4f0a-b1c2-d3e4f5a6b7c8')).toBe('');
  });
});

describe('normalizeDateParam', () => {
  // The shared version of a check three page controllers each wrote for
  // themselves. It is a shape test and nothing more: it answers "does this look
  // like a date the rest of the code can split on dashes", not "is this a day
  // that exists".
  test.each(['2026-03-10', '2026-01-01', '2026-12-31'])('%s is accepted as-is', (value) => {
    expect(normalizeDateParam(value)).toBe(value);
  });

  test('surrounding whitespace is trimmed off before the check', () => {
    expect(normalizeDateParam('  2026-03-10  ')).toBe('2026-03-10');
  });

  test.each([
    ['a European ordering', '10-03-2026'],
    ['slashes', '2026/03/10'],
    ['a two-digit year', '26-03-10'],
    ['a single-digit month', '2026-3-10'],
    ['a timestamp', '2026-03-10T08:00:00.000Z'],
    ['a word', 'today'],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('%s is rejected', (_label, value) => {
    expect(normalizeDateParam(value)).toBe('');
  });

  test.each([null, undefined, 0, {}, []])('%p is rejected rather than coerced', (value) => {
    expect(normalizeDateParam(value)).toBe('');
  });

  test('a date that is well-shaped but impossible is accepted', () => {
    // Worth stating plainly, because callers pass the result straight to
    // `new Date(y, m - 1, d)`, which rolls 2026-13-45 over into February 2027.
    // The check is deliberately about shape; anything that needs a real
    // calendar day has to say so itself.
    expect(normalizeDateParam('2026-13-45')).toBe('2026-13-45');
    expect(normalizeDateParam('2026-02-30')).toBe('2026-02-30');
    expect(normalizeDateParam('0000-00-00')).toBe('0000-00-00');
  });

  test('a longer string containing a valid date is still rejected', () => {
    // Anchored at both ends, so a date with anything appended does not sneak
    // through and become a query parameter.
    expect(normalizeDateParam('2026-03-10 and more')).toBe('');
    expect(normalizeDateParam('x2026-03-10')).toBe('');
  });
});
