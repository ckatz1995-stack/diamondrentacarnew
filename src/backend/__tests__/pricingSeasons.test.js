import { resolveDynamicPricingRate } from '../pricingCatalog.jsw';

// Which season a booking falls in, and therefore which rate it is charged.
//
// The original coverage analysis flagged this as a risk and it stayed
// uncovered: a repeatYearly season that runs from December into January wraps
// the year end, so the comparison cannot be a simple "start <= date <= end". A
// winter rate that silently stops applying on 1 January is not an error anyone
// sees — it is a quieter bill.
//
// seasonMatchesDate and findActiveSeason are internal, so everything here goes
// through resolveDynamicPricingRate, which is what actually prices a booking.
//
// This suite passes under both TZ=UTC and TZ=Europe/Athens, which is the point
// worth keeping: the matcher normalises to local midnight but compares UTC
// month/day, and those two shifts cancel into local-date semantics. Run it with
// TZ=Europe/Athens if you touch the matcher — a change that looks like tidying
// the mix into all-UTC moves every season boundary by a day for a deployment
// that is not on UTC.

const WINTER_RATE = 30;
const SUMMER_RATE = 90;
const BASE_RATE = 50;

function season(over = {}) {
  return { key: 'winter', label: 'Winter', startDate: '2025-12-15', endDate: '2026-01-10', active: true, ...over };
}

function rule(over = {}) {
  return { key: 'eco-winter', label: 'ECO winter', categoryCode: 'ECO', seasonKey: 'winter', minDays: 1, maxDays: 0, pricePerDay: WINTER_RATE, active: true, ...over };
}

function rateOn(pickupDateTime, { seasons = [], rules = [], billableDays = 3 } = {}) {
  return resolveDynamicPricingRate({
    categoryCode: 'ECO',
    billableDays,
    pickupDateTime: new Date(pickupDateTime),
    fallbackPricePerDay: BASE_RATE,
    catalog: { pricingSeasons: seasons, categoryRateRules: rules },
  });
}

describe('a season that wraps the year end', () => {
  // 15 December to 10 January, repeating every year — the case the plain
  // comparison gets wrong, because the start is numerically after the end.
  const wrapping = [season({ repeatYearly: true })];
  const rules = [rule()];
  const priceOn = (date) => rateOn(date, { seasons: wrapping, rules }).pricePerDay;

  test.each([
    ['just after it starts', '2026-12-20T09:00:00.000Z'],
    ['on New Year\'s Eve', '2026-12-31T09:00:00.000Z'],
    ['on New Year\'s Day', '2027-01-01T09:00:00.000Z'],
    ['a few days into January', '2027-01-05T09:00:00.000Z'],
  ])('applies the winter rate %s', (_label, date) => {
    expect(priceOn(date)).toBe(WINTER_RATE);
  });

  test.each([
    ['the day before it starts', '2026-12-14T09:00:00.000Z'],
    ['the day after it ends', '2027-01-11T09:00:00.000Z'],
    ['in high summer', '2026-07-15T09:00:00.000Z'],
    ['in the spring', '2026-04-01T09:00:00.000Z'],
  ])('does not apply %s', (_label, date) => {
    expect(priceOn(date)).toBe(BASE_RATE);
  });

  test.each([
    ['its first day', '2026-12-15T09:00:00.000Z'],
    ['its last day', '2027-01-10T09:00:00.000Z'],
  ])('includes %s', (_label, date) => {
    // Half-open would cost the customer a day of the rate they were quoted.
    expect(priceOn(date)).toBe(WINTER_RATE);
  });

  test('applies in a year far from the one it was configured in', () => {
    // The whole point of repeatYearly: the stored dates are 2025/2026 and this
    // is 2031. Comparing full dates rather than month-and-day would leave the
    // season permanently in the past.
    expect(priceOn('2031-12-20T09:00:00.000Z')).toBe(WINTER_RATE);
    expect(priceOn('2031-01-05T09:00:00.000Z')).toBe(WINTER_RATE);
  });
});

describe('a season inside one year', () => {
  // July to September, repeating — start before end, the ordinary case, kept
  // alongside the wrapping one so a fix for either cannot quietly break the
  // other.
  const summer = [season({ key: 'summer', label: 'Summer', startDate: '2026-07-01', endDate: '2026-09-15', repeatYearly: true })];
  const rules = [rule({ key: 'eco-summer', seasonKey: 'summer', pricePerDay: SUMMER_RATE })];
  const priceOn = (date) => rateOn(date, { seasons: summer, rules }).pricePerDay;

  test.each([
    ['in the middle', '2026-08-01T09:00:00.000Z'],
    ['on its first day', '2026-07-01T09:00:00.000Z'],
    ['on its last day', '2026-09-15T09:00:00.000Z'],
  ])('applies %s', (_label, date) => {
    expect(priceOn(date)).toBe(SUMMER_RATE);
  });

  test.each([
    ['the day before', '2026-06-30T09:00:00.000Z'],
    ['the day after', '2026-09-16T09:00:00.000Z'],
    ['in midwinter', '2026-01-05T09:00:00.000Z'],
  ])('does not apply %s', (_label, date) => {
    expect(priceOn(date)).toBe(BASE_RATE);
  });

  test('repeats into later years', () => {
    expect(priceOn('2030-08-01T09:00:00.000Z')).toBe(SUMMER_RATE);
  });
});

describe('a season that does not repeat', () => {
  const oneOff = [season({ key: 'expo', label: 'Trade fair', startDate: '2026-09-05', endDate: '2026-09-12', repeatYearly: false })];
  const rules = [rule({ key: 'eco-expo', seasonKey: 'expo', pricePerDay: SUMMER_RATE })];
  const priceOn = (date) => rateOn(date, { seasons: oneOff, rules }).pricePerDay;

  test('applies within its dates', () => {
    expect(priceOn('2026-09-08T09:00:00.000Z')).toBe(SUMMER_RATE);
  });

  test('does not come back the following year', () => {
    // A one-off event priced up for one week must not reprice the same week
    // every year afterwards.
    expect(priceOn('2027-09-08T09:00:00.000Z')).toBe(BASE_RATE);
  });

  test('does not apply the year before it', () => {
    expect(priceOn('2025-09-08T09:00:00.000Z')).toBe(BASE_RATE);
  });
});

describe('choosing between seasons that both match', () => {
  const rules = [
    rule({ key: 'eco-winter', seasonKey: 'winter', pricePerDay: WINTER_RATE }),
    rule({ key: 'eco-xmas', seasonKey: 'xmas', pricePerDay: SUMMER_RATE }),
  ];

  test('the higher priority wins', () => {
    // Christmas sits inside winter. Both match; the more specific one is meant
    // to carry the higher priority and take precedence.
    const seasons = [
      season({ key: 'winter', startDate: '2025-12-01', endDate: '2026-02-28', repeatYearly: true, priority: 1 }),
      season({ key: 'xmas', startDate: '2025-12-20', endDate: '2026-01-02', repeatYearly: true, priority: 10 }),
    ];
    expect(rateOn('2026-12-25T09:00:00.000Z', { seasons, rules }).pricePerDay).toBe(SUMMER_RATE);
  });

  test('the order the seasons are stored in does not decide it', () => {
    // Same two seasons, listed the other way round.
    const seasons = [
      season({ key: 'xmas', startDate: '2025-12-20', endDate: '2026-01-02', repeatYearly: true, priority: 10 }),
      season({ key: 'winter', startDate: '2025-12-01', endDate: '2026-02-28', repeatYearly: true, priority: 1 }),
    ];
    expect(rateOn('2026-12-25T09:00:00.000Z', { seasons, rules }).pricePerDay).toBe(SUMMER_RATE);
  });

  test('an inactive season is not considered, whatever its priority', () => {
    const seasons = [
      season({ key: 'winter', startDate: '2025-12-01', endDate: '2026-02-28', repeatYearly: true, priority: 1 }),
      season({ key: 'xmas', startDate: '2025-12-20', endDate: '2026-01-02', repeatYearly: true, priority: 10, active: false }),
    ];
    expect(rateOn('2026-12-25T09:00:00.000Z', { seasons, rules }).pricePerDay).toBe(WINTER_RATE);
  });

  test('the resolved season is reported back, so a quote can say which applied', () => {
    const seasons = [season({ repeatYearly: true })];
    const result = rateOn('2026-12-20T09:00:00.000Z', { seasons, rules: [rule()] });
    expect(result.season).toMatchObject({ key: 'winter', label: 'Winter' });
    expect(result.source).toBe('dynamicRule');
  });
});

describe('seasons with unusable dates', () => {
  test.each([
    ['no start date', { startDate: '' }],
    ['no end date', { endDate: '' }],
    ['an unparseable start date', { startDate: 'next winter' }],
    ['an unparseable end date', { endDate: 'sometime' }],
  ])('a season with %s never matches, rather than matching everything', (_label, over) => {
    // Failing open here would apply a seasonal rate all year round.
    const seasons = [season({ repeatYearly: true, ...over })];
    expect(rateOn('2026-12-20T09:00:00.000Z', { seasons, rules: [rule()] }).pricePerDay).toBe(BASE_RATE);
  });

  test('a booking with no pickup date falls back to the base price', () => {
    const result = resolveDynamicPricingRate({
      categoryCode: 'ECO',
      billableDays: 3,
      pickupDateTime: null,
      fallbackPricePerDay: BASE_RATE,
      catalog: { pricingSeasons: [season({ repeatYearly: true })], categoryRateRules: [rule()] },
    });
    expect(result.pricePerDay).toBe(BASE_RATE);
    expect(result.season).toBeNull();
  });

  test('a one-day season matches only that day', () => {
    const seasons = [season({ key: 'nye', startDate: '2025-12-31', endDate: '2025-12-31', repeatYearly: true })];
    const rules = [rule({ key: 'eco-nye', seasonKey: 'nye', pricePerDay: SUMMER_RATE })];
    expect(rateOn('2026-12-31T09:00:00.000Z', { seasons, rules }).pricePerDay).toBe(SUMMER_RATE);
    expect(rateOn('2026-12-30T09:00:00.000Z', { seasons, rules }).pricePerDay).toBe(BASE_RATE);
    expect(rateOn('2027-01-01T09:00:00.000Z', { seasons, rules }).pricePerDay).toBe(BASE_RATE);
  });
});

describe('how a season interacts with the day bands', () => {
  const seasons = [season({ repeatYearly: true })];

  test('a seasonal rule still has to match the length of stay', () => {
    // In season, but the only seasonal rule is for long stays.
    const rules = [rule({ key: 'eco-winter-long', minDays: 7, maxDays: 0, pricePerDay: WINTER_RATE })];
    expect(rateOn('2026-12-20T09:00:00.000Z', { seasons, rules, billableDays: 3 }).pricePerDay).toBe(BASE_RATE);
    expect(rateOn('2026-12-20T09:00:00.000Z', { seasons, rules, billableDays: 8 }).pricePerDay).toBe(WINTER_RATE);
  });

  test('a seasonal rule beats a general one for the same stay', () => {
    const rules = [
      rule({ key: 'eco-any', seasonKey: '', pricePerDay: BASE_RATE + 5 }),
      rule({ key: 'eco-winter', seasonKey: 'winter', pricePerDay: WINTER_RATE }),
    ];
    expect(rateOn('2026-12-20T09:00:00.000Z', { seasons, rules }).pricePerDay).toBe(WINTER_RATE);
  });

  test('a rule for a different season does not apply in this one', () => {
    const rules = [rule({ key: 'eco-summer', seasonKey: 'summer', pricePerDay: SUMMER_RATE })];
    expect(rateOn('2026-12-20T09:00:00.000Z', { seasons, rules }).pricePerDay).toBe(BASE_RATE);
  });

  test('out of season, a general rule still applies', () => {
    const rules = [rule({ key: 'eco-any', seasonKey: '', pricePerDay: BASE_RATE + 5 })];
    expect(rateOn('2026-07-15T09:00:00.000Z', { seasons, rules }).pricePerDay).toBe(BASE_RATE + 5);
  });

  test('out of season, a seasonal rule does not leak into the price', () => {
    // The mirror of the above, and the one that costs money: a winter rate
    // applying in July.
    const rules = [rule()];
    expect(rateOn('2026-07-15T09:00:00.000Z', { seasons, rules }).pricePerDay).toBe(BASE_RATE);
  });
});
