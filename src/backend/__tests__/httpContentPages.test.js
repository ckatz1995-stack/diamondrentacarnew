import { getPublicPricingCatalog } from 'backend/pricingCatalog.jsw';
import { get_insurance_terms, get_insurance_details, get_rental_terms } from '../http-functions.js';

// The three public terms pages. They are served to anyone, they are rendered
// server-side, and everything on them — the company name, the insurance plan
// labels and descriptions, the terms text itself — comes out of the CMS, where a
// staff member types it.
//
// So the whole of the risk is escaping. These pages are assembled by string
// concatenation into a full HTML document, and a stray angle bracket in a
// business-settings field is served to the public internet as markup.
//
// They also fail closed: if the catalog cannot be loaded the handler still
// returns a page rather than a stack trace, and that path is asserted too.

jest.mock('backend/pricingCatalog.jsw', () => ({
  getPublicPricingCatalog: jest.fn(),
}));

const PAGES = [
  ['insurance terms', get_insurance_terms],
  ['insurance details', get_insurance_details],
  ['rental terms', get_rental_terms],
];

function catalog({ settings = {}, plans = [] } = {}) {
  getPublicPricingCatalog.mockResolvedValue({ businessSettings: settings, insurancePlans: plans });
}

const render = async (fn) => (await fn({ query: {}, headers: {} }));

beforeEach(() => {
  getPublicPricingCatalog.mockReset();
  catalog();
});

describe('every terms page', () => {
  test.each(PAGES)('%s is served as an HTML document', async (_label, fn) => {
    const response = await render(fn);
    expect(response.status).toBe(200);
    expect(response.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(response.body.startsWith('<!doctype html>')).toBe(true);
    expect(response.body.trimEnd().endsWith('</html>')).toBe(true);
  });

  test.each(PAGES)('%s is not cached, so a terms edit is not served stale', async (_label, fn) => {
    expect((await render(fn)).headers['Cache-Control']).toBe('no-store');
  });

  test.each(PAGES)('%s declares Greek as its language', async (_label, fn) => {
    expect((await render(fn)).body).toContain('<html lang="el">');
  });

  test.each(PAGES)('%s falls back to the house brand when settings are empty', async (_label, fn) => {
    const body = (await render(fn)).body;
    expect(body).toContain('DIAMOND Rent A Car');
    expect(body).toContain('Thessaloniki');
    expect(body).not.toContain('undefined');
  });

  test.each(PAGES)('%s uses the configured brand when there is one', async (_label, fn) => {
    catalog({ settings: { companyName: 'Acme Rentals', companyCity: 'Patras' } });
    const body = (await render(fn)).body;
    expect(body).toContain('Acme Rentals');
    expect(body).toContain('Patras');
  });

  test.each(PAGES)('%s keeps the house brand when the setting is only whitespace', async (_label, fn) => {
    catalog({ settings: { companyName: '   ', companyCity: '  ' } });
    const body = (await render(fn)).body;
    expect(body).toContain('DIAMOND Rent A Car');
  });

  test.each(PAGES)('%s strips spaces out of every tel: link but not the shown number', async (_label, fn) => {
    // The page carries three of these — header, contact card and footer. A
    // single toContain passes on the strength of any one of them, so every
    // match is checked.
    catalog({ settings: { companyPhone: '+30 2310 123 456' } });
    const body = (await render(fn)).body;
    const links = body.match(/href="tel:[^"]*"/g) || [];
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const link of links) expect(link).toBe('href="tel:+302310123456"');
    expect(body).toContain('+30 2310 123 456');
  });
});

describe('escaping the text a staff member typed', () => {
  const PAYLOAD = '<script>alert(1)</script>';

  test.each(PAGES)('%s escapes the company name', async (_label, fn) => {
    catalog({ settings: { companyName: PAYLOAD } });
    const body = (await render(fn)).body;
    expect(body).not.toContain(PAYLOAD);
    expect(body).toContain('&lt;script&gt;');
  });

  test.each(PAGES)('%s escapes every brand field', async (_label, fn) => {
    catalog({
      settings: {
        companyName: PAYLOAD, companyCity: PAYLOAD, companyPhone: PAYLOAD,
        companyEmail: PAYLOAD, companyAddress: PAYLOAD, footerNote: PAYLOAD,
      },
    });
    expect((await render(fn)).body).not.toMatch(/<script/i);
  });

  test.each(PAGES)('%s escapes an insurance plan label and description', async (_label, fn) => {
    catalog({ plans: [{ key: 'cdw', label: PAYLOAD, description: PAYLOAD, pricePerDay: 12 }] });
    const body = (await render(fn)).body;
    expect(body).not.toContain(PAYLOAD);
    expect(body).not.toMatch(/<script/i);
  });

  test.each(PAGES)('%s survives a quote without breaking out of an attribute', async (_label, fn) => {
    catalog({ settings: { companyPhone: '" onload="alert(1)' } });
    const body = (await render(fn)).body;
    expect(body).not.toContain('onload="alert(1)"');
    expect(body).toContain('&quot;');
  });

  test.each(PAGES)('%s is still one document after a markup payload', async (_label, fn) => {
    catalog({ settings: { companyName: '</head><body><h1>hijacked</h1>' } });
    const body = (await render(fn)).body;
    expect(body.match(/<\/html>/g) || []).toHaveLength(1);
    expect(body.match(/<!doctype html>/gi) || []).toHaveLength(1);
  });

  test('an ampersand is escaped once, not twice', async () => {
    // Escaping & after < and > would turn &lt; into &amp;lt; and show the markup
    // to the reader instead of rendering it.
    catalog({ settings: { companyName: 'Smith & Sons' } });
    const body = (await render(get_rental_terms)).body;
    expect(body).toContain('Smith &amp; Sons');
    expect(body).not.toContain('&amp;amp;');
  });
});

describe('the free-text terms body', () => {
  test('a paragraph of terms appears on the page', async () => {
    catalog({ settings: { rentalTermsBody: 'Ο μισθωτής οφείλει να επιστρέψει το όχημα με πλήρες ρεζερβουάρ.' } });
    expect((await render(get_rental_terms)).body).toContain('Ο μισθωτής οφείλει');
  });

  test('a blank line becomes a new paragraph', async () => {
    catalog({ settings: { rentalTermsBody: 'First clause.\n\nSecond clause.' } });
    const body = (await render(get_rental_terms)).body;
    expect(body).toContain('<p>First clause.</p>');
    expect(body).toContain('<p>Second clause.</p>');
  });

  test('a single newline stays inside the same paragraph', async () => {
    catalog({ settings: { rentalTermsBody: 'First line.\nSecond line.' } });
    expect((await render(get_rental_terms)).body).toContain('<p>First line.<br>Second line.</p>');
  });

  test('a dashed block becomes a list', async () => {
    catalog({ settings: { rentalTermsBody: '- Δίπλωμα οδήγησης\n- Ταυτότητα\n- Πιστωτική κάρτα' } });
    const body = (await render(get_rental_terms)).body;
    expect(body).toContain('<ul><li>Δίπλωμα οδήγησης</li><li>Ταυτότητα</li><li>Πιστωτική κάρτα</li></ul>');
  });

  test('a bulleted block becomes a list too', async () => {
    catalog({ settings: { rentalTermsBody: '• One\n• Two' } });
    expect((await render(get_rental_terms)).body).toContain('<ul><li>One</li><li>Two</li></ul>');
  });

  test('a single dashed line is a paragraph, not a one-item list', async () => {
    catalog({ settings: { rentalTermsBody: '- Just the one' } });
    const body = (await render(get_rental_terms)).body;
    expect(body).toContain('<p>- Just the one</p>');
    expect(body).not.toContain('<li>Just the one</li>');
  });

  test('a block where only some lines are dashed stays a paragraph', async () => {
    catalog({ settings: { rentalTermsBody: 'Bring these:\n- Licence' } });
    const body = (await render(get_rental_terms)).body;
    expect(body).not.toContain('<ul>');
  });

  test('a section with no text shows the placeholder rather than an empty box', async () => {
    catalog({ settings: {} });
    expect((await render(get_rental_terms)).body).toContain('Δεν έχει οριστεί ακόμη περιεχόμενο.');
  });

  test('markup inside a list item is escaped', async () => {
    catalog({ settings: { rentalTermsBody: '- <b>bold</b>\n- <i>italic</i>' } });
    const body = (await render(get_rental_terms)).body;
    expect(body).toContain('<li>&lt;b&gt;bold&lt;/b&gt;</li>');
    expect(body).not.toContain('<li><b>bold</b></li>');
  });

  test('markup inside a paragraph is escaped', async () => {
    catalog({ settings: { rentalTermsBody: 'Read <b>this</b> carefully.' } });
    const body = (await render(get_rental_terms)).body;
    expect(body).toContain('Read &lt;b&gt;this&lt;/b&gt; carefully.');
  });

  test('all four rental sections are rendered', async () => {
    catalog({
      settings: {
        rentalTermsBody: 'AAA-general',
        rentalRequirementsBody: 'BBB-requirements',
        rentalPoliciesBody: 'CCC-policies',
        rentalPrivacyBody: 'DDD-privacy',
      },
    });
    const body = (await render(get_rental_terms)).body;
    for (const marker of ['AAA-general', 'BBB-requirements', 'CCC-policies', 'DDD-privacy']) {
      expect(body).toContain(marker);
    }
  });

  test('the insurance pages carry their own body text, and each reads its own field', async () => {
    catalog({ settings: { insuranceTermsBody: 'TERMS-BODY', insuranceDetailsBody: 'DETAILS-BODY' } });
    expect((await render(get_insurance_terms)).body).toContain('TERMS-BODY');
    expect((await render(get_insurance_terms)).body).not.toContain('DETAILS-BODY');
    expect((await render(get_insurance_details)).body).toContain('DETAILS-BODY');
    expect((await render(get_insurance_details)).body).not.toContain('TERMS-BODY');
  });

  test('the body falls back to the intro when there is no body', async () => {
    // The intro is also rendered as the page's standfirst, so merely finding the
    // string proves nothing — it has to appear TWICE for the body to have used
    // it as well. Asserted on the count for exactly that reason.
    catalog({ settings: { insuranceTermsIntro: 'INTRO-ONLY' } });
    const body = (await render(get_insurance_terms)).body;
    expect(body.match(/INTRO-ONLY/g) || []).toHaveLength(2);
  });

  test('a body of its own is used instead of the intro', async () => {
    catalog({ settings: { insuranceTermsBody: 'BODY-TEXT', insuranceTermsIntro: 'INTRO-ONLY' } });
    const body = (await render(get_insurance_terms)).body;
    expect(body).toContain('BODY-TEXT');
    expect(body.match(/INTRO-ONLY/g) || []).toHaveLength(1);
  });

  test.each([
    ['insurance terms', get_insurance_terms, 'insuranceTermsBody'],
    ['insurance details', get_insurance_details, 'insuranceDetailsBody'],
  ])('%s escapes markup in its body text', async (_label, fn, field) => {
    // This body goes through nl2br rather than richTextBlocks — a separate
    // escaping path from the one the rental-terms sections take.
    catalog({ settings: { [field]: '<script>alert(1)</script>' } });
    const body = (await render(fn)).body;
    expect(body).not.toMatch(/<script>alert/i);
    expect(body).toContain('&lt;script&gt;');
  });

  test.each([
    ['insurance terms', get_insurance_terms, 'insuranceTermsBody'],
    ['insurance details', get_insurance_details, 'insuranceDetailsBody'],
  ])('%s turns a single newline in its body into a line break', async (_label, fn, field) => {
    catalog({ settings: { [field]: 'First line.\nSecond line.' } });
    expect((await render(fn)).body).toContain('First line.<br>Second line.');
  });

  test.each([
    ['insurance terms', get_insurance_terms, 'insuranceTermsBody'],
    ['insurance details', get_insurance_details, 'insuranceDetailsBody'],
  ])('%s turns a blank line in its body into a new paragraph', async (_label, fn, field) => {
    catalog({ settings: { [field]: 'First para.\n\nSecond para.' } });
    expect((await render(fn)).body).toContain('First para.</p><p>Second para.');
  });
});

describe('the insurance plans on the page', () => {
  const plans = [
    { key: 'cdw', label: 'CDW', description: 'Basic cover', pricePerDay: 12 },
    { key: 'full', label: 'Full cover', description: 'Everything', pricePerDay: 20 },
  ];

  test.each(PAGES)('%s lists every plan with its price', async (_label, fn) => {
    catalog({ plans });
    const body = (await render(fn)).body;
    expect(body).toContain('CDW');
    expect(body).toContain('Full cover');
    expect(body).toContain('12,00€');
    expect(body).toContain('20,00€');
  });

  test('a price is shown to two decimals in Greek format', async () => {
    // Greek uses a comma for the decimal separator; showing 1.234,50 as 1,234.50
    // is a different number to the reader.
    catalog({ plans: [{ key: 'x', label: 'X', pricePerDay: 1234.5 }] });
    expect((await render(get_rental_terms)).body).toContain('1.234,50€');
  });

  test('a plan with no price shows zero rather than nothing', async () => {
    catalog({ plans: [{ key: 'x', label: 'X' }] });
    expect((await render(get_rental_terms)).body).toContain('0,00€');
  });

  test('a non-EUR currency is named instead of shown as a symbol', async () => {
    catalog({ settings: { currency: 'GBP' }, plans: [{ key: 'x', label: 'X', pricePerDay: 10 }] });
    const body = (await render(get_rental_terms)).body;
    expect(body).toContain('10,00 GBP');
    expect(body).not.toContain('10,00€');
  });

  test.each(PAGES)('%s falls back to a plan\'s key when it has no label', async (_label, fn) => {
    // Each page builds this block separately, so asserting on one of the three
    // leaves the other two free to drift.
    catalog({ plans: [{ key: 'scdw', pricePerDay: 5 }] });
    expect((await render(fn)).body).toContain('scdw');
  });

  test.each(PAGES)('%s still renders a heading for a plan with neither label nor key', async (_label, fn) => {
    catalog({ plans: [{ pricePerDay: 5 }] });
    expect((await render(fn)).body).toContain('Κάλυψη');
  });

  test.each(PAGES)('%s copes with no plans at all', async (_label, fn) => {
    catalog({ plans: [] });
    const response = await render(fn);
    expect(response.status).toBe(200);
    expect(response.body).not.toContain('undefined');
  });

  test.each(PAGES)('%s copes with a catalog that returns no plan array', async (_label, fn) => {
    getPublicPricingCatalog.mockResolvedValue({ businessSettings: {}, insurancePlans: null });
    const response = await render(fn);
    expect(response.status).toBe(200);
    expect(response.body).not.toContain('undefined');
  });
});

describe('when the catalog cannot be loaded', () => {
  test.each(PAGES)('%s still returns a page, marked as a server error', async (_label, fn) => {
    getPublicPricingCatalog.mockRejectedValue(new Error('catalog unavailable'));
    const response = await render(fn);
    expect(response.status).toBe(500);
    expect(response.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(response.body.startsWith('<!doctype html>')).toBe(true);
  });

  test.each(PAGES)('%s says the page could not be loaded', async (_label, fn) => {
    getPublicPricingCatalog.mockRejectedValue(new Error('catalog unavailable'));
    expect((await render(fn)).body).toContain('Δεν ήταν δυνατή η φόρτωση της σελίδας.');
  });

  test('the error message is escaped before it reaches the page', async () => {
    // The message can carry text from further down the stack, and it is the one
    // value on this page that was never typed by a person.
    getPublicPricingCatalog.mockRejectedValue(new Error('<script>alert(1)</script>'));
    const body = (await render(get_rental_terms)).body;
    expect(body).not.toMatch(/<script>alert/i);
    expect(body).toContain('&lt;script&gt;');
  });

  test('the error page offers a way back to the site', async () => {
    getPublicPricingCatalog.mockRejectedValue(new Error('catalog unavailable'));
    expect((await render(get_rental_terms)).body).toContain('href="/"');
  });

  test('a catalog that resolves to nothing is not an error', async () => {
    // An empty catalog is a site that has not been configured yet, not a fault.
    getPublicPricingCatalog.mockResolvedValue(null);
    const response = await render(get_rental_terms);
    expect(response.status).toBe(200);
    expect(response.body).toContain('DIAMOND Rent A Car');
  });
});
