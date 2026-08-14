// @ts-check
function asDate(value) {
  if (!value && value !== 0) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function computeBillableDaysDetailed(pickup, dropoff, fallbackDays = 1) {
  const start = asDate(pickup);
  const end = asDate(dropoff);
  if (!start || !end || end <= start) {
    const normalizedFallback = Math.max(1, Number.isFinite(Number(fallbackDays)) ? Number(fallbackDays) : 1);
    return { hours: 0, billableDays: normalizedFallback };
  }

  const hours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
  return {
    hours,
    billableDays: Math.max(1, Math.ceil(hours / 24))
  };
}

export function computeBillableDays(pickup, dropoff, fallbackDays = 1) {
  return computeBillableDaysDetailed(pickup, dropoff, fallbackDays).billableDays;
}
