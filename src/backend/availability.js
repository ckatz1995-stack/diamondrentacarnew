// @ts-check
// Canonical definition of "these two bookings overlap".
//
// The rule is duplicated as a wix-data filter pair in several places
// (bookingEngine.hasOverlap, bookingEngine.countOverlappingBookingsByCategoryKeys,
// fleetCalendar.moveBookingVehicleOnly / confirmAndAutoAssign / fetchBookingsInRange),
// each expressed as:
//
//   .lt(pickupDateTime,  otherEnd)    // existing pickup  < other end
//   .gt(dropoffDateTime, otherStart)  // existing dropoff > other start
//
// Those queries run in the database and are deliberately left as they are. This
// module exists so the intended semantics have one written-down, tested home: if
// the rule ever needs to change, the boundary behaviour is specified here rather
// than inferred from five query builders.

function asDate(value) {
  if (!value && value !== 0) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Half-open interval overlap: [start, end). Two bookings that merely touch —
 * one dropping off exactly when the next picks up — do NOT overlap, which is
 * what lets a vehicle be handed straight from one rental to the next.
 *
 * Symmetric in its two intervals. Returns false if any date is missing or invalid,
 * matching the callers' behaviour of refusing to act on incomplete date data.
 */
export function bookingsOverlap(startA, endA, startB, endB) {
  const aStart = asDate(startA);
  const aEnd = asDate(endA);
  const bStart = asDate(startB);
  const bEnd = asDate(endB);
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  return aStart < bEnd && aEnd > bStart;
}
