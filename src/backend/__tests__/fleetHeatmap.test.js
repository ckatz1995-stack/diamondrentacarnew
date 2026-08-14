import { buildHeatmap } from '../fleetCalendar.jsw';

const FLEET = [{ _id: 'v1' }, { _id: 'v2' }];

// Day buckets are measured from `from`, in 24-hour steps of wall-clock UTC.
const WINDOW = { from: '2026-01-01T00:00:00Z', to: '2026-01-06T00:00:00Z' }; // 5 days

function heatFor(items, window = WINDOW) {
  return buildHeatmap({ ...window, fleet: FLEET, items });
}

const item = (start, end, resource = 'v1') => ({ resource, start, end });

describe('buildHeatmap — window shape', () => {
  test('reports one bucket per whole day in the window', () => {
    const result = heatFor([]);
    expect(result.days).toBe(5);
    expect(result.heat.v1).toEqual([0, 0, 0, 0, 0]);
  });

  test('gives every fleet vehicle a row, even with no bookings', () => {
    const result = heatFor([]);
    expect(Object.keys(result.heat).sort()).toEqual(['v1', 'v2']);
  });

  test('never reports fewer than one day, even for a zero-length window', () => {
    const result = heatFor([], { from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' });
    expect(result.days).toBe(1);
  });

  test('rounds a partial trailing day up to a whole bucket', () => {
    const result = heatFor([], { from: '2026-01-01T00:00:00Z', to: '2026-01-03T06:00:00Z' });
    expect(result.days).toBe(3);
  });
});

describe('buildHeatmap — occupancy', () => {
  test('marks the days a booking covers', () => {
    const result = heatFor([item('2026-01-03T00:00:00Z', '2026-01-04T00:00:00Z')]);
    expect(result.heat.v1).toEqual([0, 0, 1, 1, 0]);
  });

  test('counts concurrent bookings on the same vehicle and day', () => {
    // A count above 1 means a genuine double-booking, which is what makes this
    // heatmap worth reading rather than a simple busy/free flag.
    const result = heatFor([
      item('2026-01-02T09:00:00Z', '2026-01-02T12:00:00Z'),
      item('2026-01-02T10:00:00Z', '2026-01-02T18:00:00Z'),
    ]);
    expect(result.heat.v1).toEqual([0, 2, 0, 0, 0]);
  });

  test('keeps vehicles independent', () => {
    const result = heatFor([
      item('2026-01-02T09:00:00Z', '2026-01-02T12:00:00Z', 'v1'),
      item('2026-01-04T09:00:00Z', '2026-01-04T12:00:00Z', 'v2'),
    ]);
    expect(result.heat.v1).toEqual([0, 1, 0, 0, 0]);
    expect(result.heat.v2).toEqual([0, 0, 0, 1, 0]);
  });

  test('ignores bookings for a vehicle that is not in the fleet list', () => {
    const result = heatFor([item('2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', 'ghost')]);
    expect(result.heat.v1).toEqual([0, 0, 0, 0, 0]);
    expect(result.heat).not.toHaveProperty('ghost');
  });
});

describe('buildHeatmap — window boundaries', () => {
  test('clamps a booking that starts before the window', () => {
    const result = heatFor([item('2025-12-20T00:00:00Z', '2026-01-02T12:00:00Z')]);
    expect(result.heat.v1).toEqual([1, 1, 0, 0, 0]);
  });

  test('clamps a booking that runs past the end of the window', () => {
    const result = heatFor([item('2026-01-04T12:00:00Z', '2026-03-01T00:00:00Z')]);
    expect(result.heat.v1).toEqual([0, 0, 0, 1, 1]);
  });

  test('fills every bucket for a booking spanning the whole window', () => {
    const result = heatFor([item('2025-12-01T00:00:00Z', '2026-03-01T00:00:00Z')]);
    expect(result.heat.v1).toEqual([1, 1, 1, 1, 1]);
  });

  test('ignores a booking entirely before the window', () => {
    const result = heatFor([item('2025-12-01T00:00:00Z', '2025-12-05T00:00:00Z')]);
    expect(result.heat.v1).toEqual([0, 0, 0, 0, 0]);
  });

  test('ignores a booking entirely after the window', () => {
    const result = heatFor([item('2026-03-01T00:00:00Z', '2026-03-05T00:00:00Z')]);
    expect(result.heat.v1).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('buildHeatmap — day-boundary behaviour', () => {
  test('a dropoff exactly at midnight still marks that day busy', () => {
    // Bucketing floors the end timestamp, so a rental returned at 00:00 on day 2
    // occupies day 2's bucket. Pinned deliberately: it is the conservative
    // reading for a fleet view (the vehicle is not yet back on the lot at 00:00),
    // and it is the kind of off-by-one that would otherwise change unnoticed.
    const result = heatFor([item('2026-01-01T10:00:00Z', '2026-01-03T00:00:00Z')]);
    expect(result.heat.v1).toEqual([1, 1, 1, 0, 0]);
  });

  test('a booking inside a single day occupies exactly one bucket', () => {
    const result = heatFor([item('2026-01-02T09:00:00Z', '2026-01-02T17:00:00Z')]);
    expect(result.heat.v1).toEqual([0, 1, 0, 0, 0]);
  });

  test('buckets are measured from the window start, not from local midnight', () => {
    // With a window starting at 10:00, day 0 runs 10:00-10:00, not 00:00-00:00.
    // Worth stating: callers passing a non-midnight `from` get shifted buckets.
    const result = heatFor(
      [item('2026-01-02T00:00:00Z', '2026-01-02T09:00:00Z')],
      { from: '2026-01-01T10:00:00Z', to: '2026-01-04T10:00:00Z' },
    );
    expect(result.days).toBe(3);
    expect(result.heat.v1).toEqual([1, 0, 0]);
  });
});

describe('buildHeatmap — degenerate input', () => {
  test('tolerates no items and no fleet', () => {
    expect(() => buildHeatmap({ ...WINDOW, fleet: [], items: [] })).not.toThrow();
    expect(() => buildHeatmap({ ...WINDOW })).not.toThrow();
  });

  test('echoes the window back as ISO strings', () => {
    const result = heatFor([]);
    expect(result.from).toBe('2026-01-01T00:00:00.000Z');
    expect(result.to).toBe('2026-01-06T00:00:00.000Z');
  });
});
