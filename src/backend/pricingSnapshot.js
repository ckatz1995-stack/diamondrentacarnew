import { computeBillableDays } from 'backend/billableDays';

function text(value, fallback = '') {
  const out = String(value ?? '').trim();
  return out || fallback;
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round2(value) {
  return Math.round(num(value) * 100) / 100;
}

function buildCatalogMaps(catalog = {}) {
  const insurancePlans = Array.isArray(catalog.insurancePlans) ? catalog.insurancePlans : [];
  const extraServices = Array.isArray(catalog.extraServices) ? catalog.extraServices : [];
  return {
    insuranceByKey: insurancePlans.reduce((acc, item) => {
      const key = text(item?.key, '').toLowerCase();
      if (key) acc[key] = item;
      return acc;
    }, {}),
    extrasByKey: extraServices.reduce((acc, item) => {
      const key = text(item?.key, '');
      if (key) acc[key] = item;
      return acc;
    }, {})
  };
}

function normalizeExtraDetails(rawExtras, days, extrasByKey) {
  const source = Array.isArray(rawExtras) ? rawExtras : [];
  return source.map((item) => {
    if (typeof item === 'string') {
      const key = text(item, '');
      const cfg = extrasByKey[key] || {};
      const unitPrice = round2(cfg.price ?? cfg.pricePerDay ?? 0);
      const billingMode = text(cfg.billingMode || cfg.mode, 'perDay') === 'perBooking' ? 'perBooking' : 'perDay';
      return {
        key,
        label: text(cfg.label || key, key),
        billingMode,
        unitPrice,
        quantity: billingMode === 'perBooking' ? 1 : days,
        lineTotal: round2(billingMode === 'perBooking' ? unitPrice : unitPrice * days),
        refId: text(cfg._id, '')
      };
    }

    const key = text(item?.key || item?.id || item?.value || item?.label || item?.name, '');
    const cfg = extrasByKey[key] || {};
    const billingMode = text(item?.billingMode || item?.mode || cfg.billingMode || cfg.mode, 'perDay') === 'perBooking' ? 'perBooking' : 'perDay';
    const unitPrice = round2(item?.unitPrice ?? item?.price ?? item?.pricePerDay ?? cfg.price ?? cfg.pricePerDay ?? 0);
    const quantity = billingMode === 'perBooking' ? 1 : Math.max(1, num(item?.quantity, days));
    return {
      key,
      label: text(item?.label || item?.title || item?.name || cfg.label || key, key),
      billingMode,
      unitPrice,
      quantity,
      lineTotal: round2(item?.lineTotal ?? (billingMode === 'perBooking' ? unitPrice : unitPrice * quantity)),
      refId: text(item?._id || cfg._id, '')
    };
  }).filter((item) => item.key || item.label);
}

/**
 * @param {{ catalog?: any, booking?: any, selectedPackage?: any, selectedExtrasDetails?: any,
 *           charges?: any, capturedAt?: any, source?: string }} [options]
 */
export function buildPricingSnapshot({ catalog = {}, booking = {}, selectedPackage, selectedExtrasDetails, charges = {}, capturedAt, source = 'booking-flow' } = {}) {
  const businessSettings = catalog?.businessSettings || {};
  const { insuranceByKey, extrasByKey } = buildCatalogMaps(catalog);
  const days = Math.max(1, num(booking?.billableDays, computeBillableDays(booking?.pickupDateTime, booking?.dropoffDateTime, 1)));
  const packageKey = text(selectedPackage || booking?.selectedPackage, '').toLowerCase();
  const packageCfg = insuranceByKey[packageKey] || {};
  const normalizedExtras = normalizeExtraDetails(selectedExtrasDetails || booking?.selectedExtrasDetails || booking?.selectedExtras, days, extrasByKey);

  const baseCost = round2(booking?.baseCost ?? charges?.rental ?? (num(booking?.basePricePerDay, 0) * days));
  const insuranceCost = round2(booking?.insuranceCost ?? charges?.insurance ?? (num(booking?.insuranceExtraPerDay, 0) * days));
  const extrasCost = round2(booking?.extrasTotal ?? charges?.options ?? normalizedExtras.reduce((sum, item) => sum + num(item.lineTotal, 0), 0));
  const ageFee = round2(booking?.ageFee ?? charges?.ageFee ?? 0);
  const nightFee = round2(booking?.nightFee ?? charges?.nightFee ?? 0);
  const transport = round2(charges?.transport ?? 0);
  const damages = round2(charges?.damages ?? 0);
  const surcharges = round2(charges?.surcharges ?? 0);
  const discount = round2(charges?.discount ?? 0);

  const grossTotal = round2(booking?.totalPrice ?? (baseCost + insuranceCost + extrasCost + ageFee + nightFee + transport + damages + surcharges - discount));
  const vatRate = num(businessSettings?.vatRateDecimal, num(booking?.vatRate, 0.24));
  const netAmount = vatRate > 0 ? round2(grossTotal / (1 + vatRate)) : grossTotal;
  const vatAmount = round2(grossTotal - netAmount);

  return {
    schemaVersion: 1,
    source,
    capturedAt: text(capturedAt, new Date().toISOString()),
    currency: text(businessSettings?.currency, 'EUR'),
    vatRate: vatRate,
    billableDays: days,
    pickupDateTime: booking?.pickupDateTime || null,
    dropoffDateTime: booking?.dropoffDateTime || null,
    basePricePerDay: round2(booking?.basePricePerDay ?? (days > 0 ? baseCost / days : 0)),
    insuranceExtraPerDay: round2(booking?.insuranceExtraPerDay ?? (days > 0 ? insuranceCost / days : 0)),
    selectedPackage: {
      key: packageKey,
      label: text(packageCfg?.label, packageKey ? packageKey.toUpperCase() : ''),
      pricePerDay: round2(packageCfg?.pricePerDay ?? packageCfg?.price ?? booking?.insuranceExtraPerDay ?? 0),
      refId: text(packageCfg?._id, '')
    },
    selectedExtras: normalizedExtras,
    breakdown: {
      rental: baseCost,
      insurance: insuranceCost,
      options: extrasCost,
      ageFee,
      nightFee,
      transport,
      damages,
      surcharges,
      discount,
      gross: grossTotal,
      net: netAmount,
      vat: vatAmount
    },
    refs: {
      businessSettingsId: text(businessSettings?._id, ''),
      insurancePlanId: text(packageCfg?._id, ''),
      extraServiceIds: normalizedExtras.map((item) => item.refId).filter(Boolean)
    }
  };
}
