import {
  computeAutomaticFees,
  getFallbackCatalogSnapshot,
  resolveDynamicPricingRate,
  clearPricingCatalogCache,
  isNightShift,
} from '../pricingCatalog.jsw';

// Default business settings (from pricingCatalog.jsw) use nightStartHour: 22,
// nightEndHour: 8 in Europe/Athens local time. January is EET (UTC+2).
const ATHENS_NIGHT_UTC = '2026-01-15T21:30:00Z'; // 23:30 Athens -> night
const ATHENS_DAY_UTC = '2026-01-15T10:00:00Z'; // 12:00 Athens -> daytime

describe('computeAutomaticFees', () => {
  test('applies the fallback age fee for a 19-22 driver with no matching fee rule', () => {
    const result = computeAutomaticFees({ driverAge: '19-22', feeRules: [] });
    expect(result.ageFee).toBe(16);
    expect(result.appliedRules.ageRule).toBeNull();
  });

  test('applies the fallback age fee for a 70+ driver', () => {
    const result = computeAutomaticFees({ driverAge: '70+', feeRules: [] });
    expect(result.ageFee).toBe(10);
  });

  test('charges no age fee for a driver outside the surcharge age bands', () => {
    const result = computeAutomaticFees({ driverAge: '30-40', feeRules: [] });
    expect(result.ageFee).toBe(0);
  });

  test('uses a matching CMS fee rule amount over the hardcoded fallback', () => {
    const feeRules = [{ key: 'youngDriver19to22', ruleType: 'ageRange', audienceGroup: '19-22', amount: 25, label: 'Custom young driver fee' }];
    const result = computeAutomaticFees({ driverAge: '19-22', feeRules });
    expect(result.ageFee).toBe(25);
    expect(result.appliedRules.ageRule).toMatchObject({ key: 'youngDriver19to22', amount: 25 });
  });

  test('adds a night fee when pickup falls in the night window (Athens local time)', () => {
    const result = computeAutomaticFees({
      pickupDateTime: new Date(ATHENS_NIGHT_UTC),
      dropoffDateTime: new Date(ATHENS_DAY_UTC),
      feeRules: [],
    });
    expect(result.nightFee).toBe(15);
    expect(result.appliedRules.pickupNight).toMatchObject({ amount: 15 });
    expect(result.appliedRules.dropoffNight).toBeNull();
  });

  test('adds combined night fees when both pickup and dropoff are in the night window', () => {
    const result = computeAutomaticFees({
      pickupDateTime: new Date(ATHENS_NIGHT_UTC),
      dropoffDateTime: new Date(ATHENS_NIGHT_UTC),
      feeRules: [],
    });
    expect(result.nightFee).toBe(30);
  });

  test('charges no night fee during daytime hours', () => {
    const result = computeAutomaticFees({
      pickupDateTime: new Date(ATHENS_DAY_UTC),
      dropoffDateTime: new Date(ATHENS_DAY_UTC),
      feeRules: [],
    });
    expect(result.nightFee).toBe(0);
  });
});

describe('resolveDynamicPricingRate', () => {
  const baseRules = [
    { key: 'eco-short', categoryCode: 'ECO', minDays: 1, maxDays: 3, pricePerDay: 40 },
    { key: 'eco-long', categoryCode: 'ECO', minDays: 4, maxDays: 0, pricePerDay: 32 },
    { key: 'eco-summer', categoryCode: 'ECO', minDays: 1, maxDays: 0, pricePerDay: 55, seasonKey: 'summer' },
  ];

  test('picks the short-stay rule for a 2-day booking with no active season', () => {
    const result = resolveDynamicPricingRate({
      categoryCode: 'ECO',
      billableDays: 2,
      catalog: { pricingSeasons: [], categoryRateRules: baseRules },
      fallbackPricePerDay: 20,
    });
    expect(result.source).toBe('dynamicRule');
    expect(result.pricePerDay).toBe(40);
    expect(result.rule.key).toBe('eco-short');
  });

  test('picks the long-stay rule for a 5-day booking with no active season', () => {
    const result = resolveDynamicPricingRate({
      categoryCode: 'ECO',
      billableDays: 5,
      catalog: { pricingSeasons: [], categoryRateRules: baseRules },
      fallbackPricePerDay: 20,
    });
    expect(result.pricePerDay).toBe(32);
    expect(result.rule.key).toBe('eco-long');
  });

  test('prefers a season-specific rate rule over a general rule when the season is active', () => {
    const summerSeason = { key: 'summer', label: 'Summer', startDate: '2026-06-01', endDate: '2026-08-31', active: true };
    const result = resolveDynamicPricingRate({
      categoryCode: 'ECO',
      billableDays: 5,
      pickupDateTime: new Date('2026-07-01T10:00:00Z'),
      catalog: { pricingSeasons: [summerSeason], categoryRateRules: baseRules },
      fallbackPricePerDay: 20,
    });
    expect(result.pricePerDay).toBe(55);
    expect(result.rule.key).toBe('eco-summer');
    expect(result.season.key).toBe('summer');
  });

  test('falls back to the provided base price when no rate rule matches', () => {
    const result = resolveDynamicPricingRate({
      categoryCode: 'SUV',
      billableDays: 2,
      catalog: { pricingSeasons: [], categoryRateRules: baseRules },
      fallbackPricePerDay: 99,
    });
    expect(result.source).toBe('vehicleBasePrice');
    expect(result.pricePerDay).toBe(99);
    expect(result.rule).toBeNull();
  });
});

describe('getFallbackCatalogSnapshot', () => {
  test('returns a usable snapshot with default insurance, extras and fee rules', () => {
    const snapshot = getFallbackCatalogSnapshot();
    expect(snapshot.businessSettings.currency).toBe('EUR');
    expect(snapshot.insurancePlans.length).toBeGreaterThan(0);
    expect(snapshot.extraServices.length).toBeGreaterThan(0);
    expect(snapshot.feeRules.length).toBeGreaterThan(0);
    expect(snapshot.pricingSeasons).toEqual([]);
    expect(snapshot.maps.insurance).toHaveProperty('cdw', 0);
  });

  test('resolves every business setting to a real default, never undefined', () => {
    // Regression test for a drifted duplicate: pricingCatalog used to carry its own
    // copy of the business-settings defaults, missing eight fields the normaliser
    // reads. Those resolved to undefined instead of a value, silently and only on
    // the fallback path. Asserting on the whole object rather than a field list
    // means a newly added setting is covered without anyone remembering to.
    const { businessSettings } = getFallbackCatalogSnapshot();
    const undefinedKeys = Object.entries(businessSettings)
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);
    expect(undefinedKeys).toEqual([]);
  });

  test('carries the operational settings that used to be missing from the duplicate', () => {
    const { businessSettings } = getFallbackCatalogSnapshot();
    expect(businessSettings.operatingHoursLabel).toBeTruthy();
    expect(businessSettings.afterHoursNotice).toBeTruthy();
    expect(businessSettings.allowOverbooking).toBe(false);
    expect(businessSettings.enableTriggeredEmails).toBe(false);
    expect(businessSettings.vehiclesPageDisplayMode).toBe('categories');
    expect(businessSettings.vehiclesPageModelsSource).toBe('fleet');
  });
});

describe('isNightShift', () => {
  // Single source of truth for the night window: bookingEngine imports this one
  // rather than keeping its own hardcoded 22:00-08:00 copy.
  describe('default window (22:00-08:00 Athens)', () => {
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

  describe('configured window', () => {
    test('honours an overnight window that wraps midnight', () => {
      const settings = { nightStartHour: 23, nightEndHour: 6 };
      // 22:00 Athens is now daytime under a later start.
      expect(isNightShift(new Date('2026-01-15T20:00:00Z'), settings)).toBe(false);
      // 23:00 Athens is night.
      expect(isNightShift(new Date('2026-01-15T21:00:00Z'), settings)).toBe(true);
      // 05:00 Athens is night, 06:00 is not.
      expect(isNightShift(new Date('2026-01-15T03:00:00Z'), settings)).toBe(true);
      expect(isNightShift(new Date('2026-01-15T04:00:00Z'), settings)).toBe(false);
    });

    test('honours a same-day window that does not wrap midnight', () => {
      // startHour < endHour takes the non-wrapping branch: night is 01:00-05:00.
      const settings = { nightStartHour: 1, nightEndHour: 5 };
      expect(isNightShift(new Date('2026-01-15T00:00:00Z'), settings)).toBe(true); // 02:00 Athens
      expect(isNightShift(new Date('2026-01-15T20:00:00Z'), settings)).toBe(false); // 22:00 Athens
    });

    test('falls back to the default window when settings omit the hours', () => {
      expect(isNightShift(new Date('2026-01-15T20:00:00Z'), {})).toBe(true);
    });
  });
});

describe('clearPricingCatalogCache', () => {
  test('returns true', () => {
    expect(clearPricingCatalogCache()).toBe(true);
  });
});
