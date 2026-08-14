// Booking total and VAT arithmetic, extracted from createBooking so it can be
// exercised without a database. The values are server-authoritative — createBooking
// ignores any money the client sends — so this is the code that decides what a
// customer is actually charged.

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round2(value) {
  return Number(toFiniteNumber(value, 0).toFixed(2));
}

/**
 * Sums the priced components of a booking and splits the gross into net + VAT.
 *
 * VAT is back-calculated: the component prices are treated as VAT-inclusive, so
 * net = total / (1 + rate) rather than total * rate being added on top.
 *
 * vatRateDecimal is a decimal fraction (0.24), not a percentage (24).
 */
export function computeBookingTotals({
  baseCost = 0,
  insuranceCost = 0,
  extrasCost = 0,
  ageFee = 0,
  nightFee = 0,
  locationFee = 0,
  vatRateDecimal = 0,
} = {}) {
  const finalBaseCost = round2(baseCost);
  const finalInsuranceCost = round2(insuranceCost);
  const finalExtrasCost = round2(extrasCost);
  const finalAgeFee = round2(ageFee);
  const finalNightFee = round2(nightFee);
  const finalLocationFee = round2(locationFee);

  const totalPrice = round2(
    finalBaseCost + finalInsuranceCost + finalExtrasCost + finalAgeFee + finalNightFee + finalLocationFee
  );

  // A rate of -1 would divide by zero; fall back to treating the total as all net.
  const rate = toFiniteNumber(vatRateDecimal, 0);
  const netAmount = rate <= -1 ? totalPrice : round2(totalPrice / (1 + rate));
  const vatAmount = round2(totalPrice - netAmount);

  return {
    baseCost: finalBaseCost,
    insuranceCost: finalInsuranceCost,
    extrasCost: finalExtrasCost,
    ageFee: finalAgeFee,
    nightFee: finalNightFee,
    locationFee: finalLocationFee,
    totalPrice,
    netAmount,
    vatAmount,
  };
}
