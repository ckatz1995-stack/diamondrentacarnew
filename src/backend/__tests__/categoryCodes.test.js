import { deriveFleetCategoryCode, extractCategoryCode, deriveAgeFee } from '../bookingEngine.jsw';
import { catCode, isOpaqueCategoryId, fleetCatCode, refId, asId, isNonRevenueBooking } from '../fleetCalendar.jsw';

describe('deriveFleetCategoryCode', () => {
  test('returns a clean short code unchanged, uppercased', () => {
    expect(deriveFleetCategoryCode('A')).toBe('A');
    expect(deriveFleetCategoryCode('eco')).toBe('ECO');
  });

  test('extracts the leading code from a descriptive label', () => {
    // Regression test: a stray backspace character in this regex made the branch
    // unreachable, so descriptive labels resolved to '' and the vehicle dropped
    // out of category matching entirely.
    expect(deriveFleetCategoryCode('A - Hyundai i10')).toBe('A');
    expect(deriveFleetCategoryCode('ECO Compact')).toBe('ECO');
  });

  test('never returns empty for a label that starts with letters', () => {
    // The specific failure the fix addresses.
    for (const label of ['A - Hyundai i10', 'B/Something', 'SUV large', 'Economy']) {
      expect(deriveFleetCategoryCode(label)).not.toBe('');
    }
  });

  test('returns empty for input with no leading letters', () => {
    expect(deriveFleetCategoryCode('123')).toBe('');
    expect(deriveFleetCategoryCode('- dash first')).toBe('');
  });

  test('returns empty for missing input', () => {
    expect(deriveFleetCategoryCode('')).toBe('');
    expect(deriveFleetCategoryCode(null)).toBe('');
    expect(deriveFleetCategoryCode(undefined)).toBe('');
  });

  test('digs through an object for the first usable field', () => {
    expect(deriveFleetCategoryCode({ category: 'A - Hyundai i10' })).toBe('A');
    expect(deriveFleetCategoryCode({ title: 'ECO Compact' })).toBe('ECO');
    expect(deriveFleetCategoryCode({ nothing: 'useful' })).toBe('');
  });

  test('truncates to three characters, so prefixes can collide', () => {
    // Documented consequence of the fix rather than an endorsement: two distinct
    // categories sharing a three-letter prefix resolve to the same code.
    expect(deriveFleetCategoryCode('Economy')).toBe('ECO');
    expect(deriveFleetCategoryCode('Economy Plus')).toBe('ECO');
  });
});

describe('extractCategoryCode', () => {
  test('takes the part before a dash', () => {
    expect(extractCategoryCode('A - Hyundai i10')).toBe('A');
    expect(extractCategoryCode('ECO-Compact')).toBe('ECO');
  });

  test('returns the whole value uppercased when there is no dash', () => {
    expect(extractCategoryCode('suv')).toBe('SUV');
  });

  test('returns empty for missing input', () => {
    expect(extractCategoryCode('')).toBe('');
    expect(extractCategoryCode(null)).toBe('');
  });
});

describe('deriveAgeFee', () => {
  test('charges the young-driver and senior bands', () => {
    expect(deriveAgeFee('19-22')).toBe(16);
    expect(deriveAgeFee('70+')).toBe(10);
  });

  test('charges nothing outside those bands, or for missing input', () => {
    expect(deriveAgeFee('30-40')).toBe(0);
    expect(deriveAgeFee('')).toBe(0);
    expect(deriveAgeFee(null)).toBe(0);
  });
});

describe('fleetCalendar catCode', () => {
  test('uppercases a clean code', () => {
    expect(catCode('a')).toBe('A');
    expect(catCode('eco')).toBe('ECO');
  });

  test('normalises a Greek capital chi to a Latin X', () => {
    // Χ (U+03A7) and X (U+0058) are visually identical; without this, a category
    // typed with the Greek letter would never match one typed with the Latin one.
    expect(catCode('Χ')).toBe('X');
  });

  test('rejects opaque database ids', () => {
    expect(catCode('3f2b1a9c-1111-2222-3333-444455556666')).toBe('');
    expect(catCode('abcdefgh12345678')).toBe('');
  });

  test('reads the first element of an array and common object fields', () => {
    expect(catCode(['b', 'c'])).toBe('B');
    expect(catCode({ code: 'b' })).toBe('B');
    expect(catCode({ title: 'c' })).toBe('C');
  });

  test('returns empty for missing input', () => {
    expect(catCode('')).toBe('');
    expect(catCode(null)).toBe('');
    expect(catCode(undefined)).toBe('');
  });

  test('does NOT reduce a descriptive label to its leading code', () => {
    // Pinning current behaviour, not endorsing it. The first-token branch here is
    // unreachable for the same reason it was in bookingEngine — a stray backspace
    // in the regex — so the whole label is uppercased instead. Left as-is
    // deliberately; bookingEngine's equivalent was fixed because its failure mode
    // (returning '') silently drops vehicles from category matching, whereas this
    // one degrades to a still-usable string.
    expect(catCode('A - Hyundai i10')).toBe('A - HYUNDAI I10');
    // Consequence worth seeing plainly: the two modules disagree about the same label.
    expect(catCode('A - Hyundai i10')).not.toBe(deriveFleetCategoryCode('A - Hyundai i10'));
  });
});

describe('isOpaqueCategoryId', () => {
  test('treats uuid-shaped values as opaque', () => {
    expect(isOpaqueCategoryId('3f2b1a9c-1111-2222-3333-444455556666')).toBe(true);
  });

  test('treats long alphanumeric run-ons as opaque', () => {
    expect(isOpaqueCategoryId('abcdefgh12345678')).toBe(true);
  });

  test('treats short codes as meaningful', () => {
    expect(isOpaqueCategoryId('A')).toBe(false);
    expect(isOpaqueCategoryId('ECO')).toBe(false);
  });

  test('treats a label containing spaces as meaningful', () => {
    expect(isOpaqueCategoryId('A - Hyundai i10')).toBe(false);
  });
});

describe('fleetCatCode', () => {
  test('falls back to "Other" when a vehicle has no usable category', () => {
    expect(fleetCatCode({ category: 'b' })).toBe('B');
    expect(fleetCatCode({})).toBe('Other');
    expect(fleetCatCode({ category: '3f2b1a9c-1111-2222-3333-444455556666' })).toBe('Other');
  });
});

describe('asId / refId', () => {
  test('asId reads an id out of a string or reference object', () => {
    expect(asId('abc')).toBe('abc');
    expect(asId({ _id: 'abc' })).toBe('abc');
    expect(asId({ id: 'abc' })).toBe('abc');
    expect(asId(null)).toBe('');
  });

  test('refId treats the unassigned sentinels as no reference', () => {
    // These arrive from the calendar UI when a booking is dragged off a vehicle.
    expect(refId('unassigned')).toBe('');
    expect(refId('null')).toBe('');
    expect(refId('undefined')).toBe('');
    expect(refId('UNASSIGNED')).toBe('');
  });

  test('refId passes a real id through unchanged', () => {
    expect(refId('vehicle-1')).toBe('vehicle-1');
    expect(refId({ _id: 'vehicle-1' })).toBe('vehicle-1');
  });
});

describe('isNonRevenueBooking', () => {
  test('flags maintenance and block entries by number or status', () => {
    expect(isNonRevenueBooking({ bookingNumber: 'BLOCK-001' })).toBe(true);
    expect(isNonRevenueBooking({ bookingNumber: 'MAINT-002' })).toBe(true);
    expect(isNonRevenueBooking({ status: 'Blocked' })).toBe(true);
    expect(isNonRevenueBooking({ status: 'maintenance' })).toBe(true);
  });

  test('treats an ordinary booking as revenue', () => {
    expect(isNonRevenueBooking({ bookingNumber: 'RNT-2026-0001', status: 'Confirmed' })).toBe(false);
    expect(isNonRevenueBooking({})).toBe(false);
  });
});
