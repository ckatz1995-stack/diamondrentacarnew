import {
  VAT_RATE,
  DEFAULT_BUSINESS_SETTINGS,
  INSURANCE_OPTIONS,
  EXTRA_OPTIONS,
  FEE_RULES,
  getInsuranceMap,
  getExtraConfigMap,
  getFallbackPricingCatalog,
} from '../bookingConfig.js';

// bookingConfig is the shipped catalogue — the prices and rules a site falls
// back to before anyone has configured anything in the CMS. pricingCatalog,
// bookingEngine and http-functions all read its constants.
//
// Its three exported map builders, though, are imported by nothing in the
// repository. They are tested here rather than deleted because deciding a
// public export is dead is the owner's call, not a test's — but the fact is
// worth stating: these three functions have no caller in src/.

describe('the shipped constants', () => {
  test('VAT is the Greek standard rate, in both spellings', () => {
    expect(VAT_RATE).toBe(0.24);
    expect(DEFAULT_BUSINESS_SETTINGS.vatRate).toBe(24);
    expect(DEFAULT_BUSINESS_SETTINGS.vatRateDecimal).toBe(VAT_RATE);
  });

  test('the night window wraps midnight', () => {
    // 22:00 to 08:00 — start greater than end is what makes it a wrap, and
    // isNightShift in pricingCatalog branches on exactly that comparison.
    expect(DEFAULT_BUSINESS_SETTINGS.nightStartHour).toBeGreaterThan(
      DEFAULT_BUSINESS_SETTINGS.nightEndHour,
    );
  });

  test('every shipped row carries the fields the readers key on', () => {
    for (const row of [...INSURANCE_OPTIONS, ...EXTRA_OPTIONS, ...FEE_RULES]) {
      expect(row.key).toEqual(expect.any(String));
      expect(row.key).not.toBe('');
      expect(row.label).toEqual(expect.any(String));
      expect(row.sortOrder).toEqual(expect.any(Number));
      expect(typeof row.active).toBe('boolean');
    }
  });

  test('the keys are unique within each list', () => {
    const keys = (rows) => rows.map((r) => r.key);
    for (const rows of [INSURANCE_OPTIONS, EXTRA_OPTIONS, FEE_RULES]) {
      expect(new Set(keys(rows)).size).toBe(rows.length);
    }
  });
});

describe('getInsuranceMap', () => {
  test('the shipped plans become a key-to-daily-price map', () => {
    expect(getInsuranceMap()).toEqual({ cdw: 0, scdw: 12, full: 20 });
  });

  test('a plan priced at zero is kept rather than dropped', () => {
    // CDW is the free tier; a map that omitted it would make the basic cover
    // look unavailable rather than free.
    expect(getInsuranceMap()).toHaveProperty('cdw', 0);
  });

  test('the key is lower-cased, and read from any of three field names', () => {
    expect(getInsuranceMap([
      { key: 'CDW', pricePerDay: 5 },
      { code: 'SCDW', pricePerDay: 10 },
      { slug: 'Full', pricePerDay: 20 },
    ])).toEqual({ cdw: 5, scdw: 10, full: 20 });
  });

  test('the price is read from either field name, and falls back to zero', () => {
    expect(getInsuranceMap([
      { key: 'a', price: 7 },
      { key: 'b', pricePerDay: 9 },
      { key: 'c' },
      { key: 'd', pricePerDay: 'free' },
    ])).toEqual({ a: 7, b: 9, c: 0, d: 0 });
  });

  test('a row with no usable key is skipped rather than keyed on empty', () => {
    expect(getInsuranceMap([{ pricePerDay: 5 }, { key: '   ', pricePerDay: 6 }, null]))
      .toEqual({});
  });

  test('a later row wins over an earlier one with the same key', () => {
    expect(getInsuranceMap([{ key: 'cdw', pricePerDay: 5 }, { key: 'cdw', pricePerDay: 8 }]))
      .toEqual({ cdw: 8 });
  });

  test('anything that is not a list falls back to the shipped plans', () => {
    // Not an empty map: a caller handing over a malformed value gets the
    // defaults, which is the behaviour the whole module exists for.
    expect(getInsuranceMap(null)).toEqual({ cdw: 0, scdw: 12, full: 20 });
    expect(getInsuranceMap('nope')).toEqual({ cdw: 0, scdw: 12, full: 20 });
  });

  test('an explicitly empty list is honoured rather than replaced', () => {
    expect(getInsuranceMap([])).toEqual({});
  });
});

describe('getExtraConfigMap', () => {
  test('the shipped extras become a map of full config objects', () => {
    const map = getExtraConfigMap();

    expect(Object.keys(map)).toEqual(EXTRA_OPTIONS.map((e) => e.key));
    for (const key of Object.keys(map)) {
      expect(map[key]).toMatchObject({
        key,
        price: expect.any(Number),
        billingMode: expect.stringMatching(/^(perDay|perBooking)$/),
        label: expect.any(String),
      });
    }
  });

  test('the key keeps its case here, unlike the insurance map', () => {
    expect(Object.keys(getExtraConfigMap([{ key: 'BabySeat', price: 5 }]))).toEqual(['BabySeat']);
  });

  test('the billing mode is perDay unless the row says perBooking', () => {
    const map = getExtraConfigMap([
      { key: 'a', billingMode: 'perBooking' },
      { key: 'b', billingMode: 'perDay' },
      { key: 'c', mode: 'perBooking' },
      { key: 'd' },
      { key: 'e', billingMode: 'weekly' },
    ]);

    expect(map.a.billingMode).toBe('perBooking');
    expect(map.b.billingMode).toBe('perDay');
    expect(map.c.billingMode).toBe('perBooking');
    expect(map.d.billingMode).toBe('perDay');
    // An unrecognised mode bills per day rather than per booking, which is the
    // safer of the two to guess wrong on a daily-rate product.
    expect(map.e.billingMode).toBe('perDay');
  });

  test('the label falls back to the title and then to the key itself', () => {
    const map = getExtraConfigMap([
      { key: 'a', label: 'A label' },
      { key: 'b', title: 'B title' },
      { key: 'c' },
    ]);

    expect(map.a.label).toBe('A label');
    expect(map.b.label).toBe('B title');
    expect(map.c.label).toBe('c');
  });

  test('the record id is carried through when there is one', () => {
    expect(getExtraConfigMap([{ key: 'a', _id: 'x-1' }]).a._id).toBe('x-1');
    expect(getExtraConfigMap([{ key: 'a' }]).a._id).toBe('');
  });

  test('the price is read from either field name and falls back to zero', () => {
    const map = getExtraConfigMap([
      { key: 'a', price: 7 },
      { key: 'b', pricePerDay: 9 },
      { key: 'c', price: 'free' },
      { key: 'd' },
    ]);

    expect([map.a.price, map.b.price, map.c.price, map.d.price]).toEqual([7, 9, 0, 0]);
  });

  test('a row with no usable key is skipped', () => {
    expect(getExtraConfigMap([{ price: 5 }, { key: '  ' }, null])).toEqual({});
  });

  test('anything that is not a list falls back to the shipped extras', () => {
    expect(Object.keys(getExtraConfigMap(undefined))).toEqual(EXTRA_OPTIONS.map((e) => e.key));
    expect(Object.keys(getExtraConfigMap(42))).toEqual(EXTRA_OPTIONS.map((e) => e.key));
  });
});

describe('getFallbackPricingCatalog', () => {
  test('it hands back the whole shipped catalogue', () => {
    const catalog = getFallbackPricingCatalog();

    expect(catalog.businessSettings).toEqual(DEFAULT_BUSINESS_SETTINGS);
    expect(catalog.insurancePlans).toEqual(INSURANCE_OPTIONS);
    expect(catalog.extraServices).toEqual(EXTRA_OPTIONS);
    expect(catalog.feeRules).toEqual(FEE_RULES);
  });

  test('every part of it is a copy, so a caller cannot edit the shipped defaults', () => {
    // The rows are the module's own constants; handing out references would let
    // one caller's edit change what every later caller falls back to.
    const catalog = getFallbackPricingCatalog();

    catalog.businessSettings.currency = 'USD';
    catalog.insurancePlans[0].pricePerDay = 999;
    catalog.extraServices[0].price = 999;
    catalog.feeRules[0].amount = 999;

    expect(DEFAULT_BUSINESS_SETTINGS.currency).toBe('EUR');
    expect(INSURANCE_OPTIONS[0].pricePerDay).toBe(0);
    expect(getFallbackPricingCatalog().insurancePlans[0].pricePerDay).toBe(0);
  });

  test('two calls do not share their row objects', () => {
    const first = getFallbackPricingCatalog();
    const second = getFallbackPricingCatalog();

    expect(first.insurancePlans[0]).not.toBe(second.insurancePlans[0]);
    expect(first.insurancePlans[0]).toEqual(second.insurancePlans[0]);
  });

  test('the copy is shallow — a nested value is still shared', () => {
    // Pinned rather than praised: businessSettings is spread one level deep, so
    // an object-valued setting would still be shared between callers. None of
    // the shipped settings is an object today, which is the only reason this
    // does not bite.
    const nested = Object.values(DEFAULT_BUSINESS_SETTINGS).filter(
      (v) => v !== null && typeof v === 'object',
    );

    expect(nested).toEqual([]);
  });
});
