import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import {
  exportContractDocumentPackage,
  exportContractPrintableModel,
  exportContractRenderedDocument,
} from '../rentalContract.jsw';

// The rental agreement, as the customer receives it.
//
// exportContractRenderedDocument runs the whole chain — package, printable
// model, HTML — and the HTML is what becomes the PDF someone signs. All three
// stages were uncovered.
//
// Two things are worth holding down here. The first is escaping: every field on
// this document comes from a customer or a desk operator, and an unescaped one
// would let a name break the layout of a legal document, or worse. The second is
// that the readiness state travels intact from the package to the page, because
// "blocked" printed as "ready" is a car handed over on a contract nobody checked.

const STAFF = 'staff@example.com';
const PASSWORD = 'correct-horse-battery';
const BOOKING_ID = 'bk-1';

function seed(extra = {}) {
  const passwordSalt = randomHex(16);
  return {
    StaffRoles: [{ _id: 'role-admin', key: 'admin', label: 'Administrator', active: true }],
    StaffUsers: [{ _id: 'user-1', email: STAFF, fullName: 'Staff', roleKey: 'admin', active: true }],
    StaffCredentials: [{
      _id: 'cred-1', email: STAFF, passwordSalt,
      passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true,
    }],
    StaffSessions: [],
    StaffAuditLog: [],
    BookingsNew: [{
      _id: BOOKING_ID,
      bookingNumber: 'RNT-2026-0001',
      status: 'Confirmed',
      customerName: 'A Customer',
      email: 'customer@example.com',
      phone: '+30 210 0000000',
      pickupDateTime: '2026-03-10T09:00:00.000Z',
      dropoffDateTime: '2026-03-13T09:00:00.000Z',
      baseCost: 135,
      insuranceCost: 36,
      totalPrice: 171,
      ...extra.booking,
    }],
    RentalsNew: [],
    FleetNew: [],
    ...extra.collections,
  };
}

let fake;
function install(s = seed()) {
  fake = createFakeWixData(s).install(wixData);
  return fake;
}

async function token() {
  const { sessionToken } = await loginStaff({ email: STAFF, password: PASSWORD });
  return sessionToken;
}

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

/** Render for a booking seeded with these extra fields. */
async function render(bookingFields = {}, documentType = 'agreement') {
  install(seed({ booking: bookingFields }));
  const result = await exportContractRenderedDocument({ authToken: await token(), bookingId: BOOKING_ID, documentType });
  expect(result.success).toBe(true);
  return result;
}

describe('the three stages of the export', () => {
  test('the package stage returns a package', async () => {
    install();
    const result = await exportContractDocumentPackage({ authToken: await token(), bookingId: BOOKING_ID });
    expect(result.success).toBe(true);
    expect(result.package).toEqual(expect.any(Object));
  });

  test('the printable stage adds a model without losing the package', async () => {
    install();
    const result = await exportContractPrintableModel({ authToken: await token(), bookingId: BOOKING_ID });
    expect(result.success).toBe(true);
    expect(result.package).toEqual(expect.any(Object));
    expect(Array.isArray(result.printable.sections)).toBe(true);
  });

  test('the rendered stage adds HTML without losing either', async () => {
    const result = await render();
    expect(result.package).toEqual(expect.any(Object));
    expect(result.printable).toEqual(expect.any(Object));
    expect(result.html).toEqual(expect.any(String));
  });

  test('a failure at an earlier stage stops the later ones', async () => {
    install();
    const result = await exportContractRenderedDocument({ authToken: await token(), bookingId: 'no-such-booking' });
    expect(result.success).toBe(false);
    expect(result.html).toBeUndefined();
  });

  test('every stage refuses an unauthenticated caller', async () => {
    install();
    for (const fn of [exportContractDocumentPackage, exportContractPrintableModel, exportContractRenderedDocument]) {
      await expect(fn({ bookingId: BOOKING_ID })).rejects.toThrow('AUTH_REQUIRED');
      await expect(fn({ authToken: 'made-up', bookingId: BOOKING_ID })).rejects.toThrow('AUTH_REQUIRED');
    }
  });
});

describe('the page it produces', () => {
  test('is a complete HTML document', async () => {
    const { html } = await render();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  test('carries the booking and rental identifiers', async () => {
    const { html } = await render();
    expect(html).toContain(BOOKING_ID);
  });

  test('names the document type in the body class and the subtitle', async () => {
    const agreement = await render({}, 'agreement');
    expect(agreement.html).toContain('class="doc-type-agreement"');
    expect(agreement.html).toContain('Rental agreement preview');

    const invoice = await render({}, 'invoice');
    expect(invoice.html).toContain('class="doc-type-invoice"');
    expect(invoice.html).toContain('Invoice preview');
  });

  test('an unrecognised type is treated as an agreement rather than as nothing', async () => {
    // buildContractDocumentPackage narrows the type to its supported set before
    // the renderer sees it, so a bad type produces the ordinary agreement rather
    // than a document with no layout. The renderer's own generic-subtitle
    // fallback is unreachable behind that, and is left as belt and braces.
    const { html, package: pkg } = await render({}, 'certificate');
    expect(pkg.meta?.documentType ?? pkg.documentType).toBe('agreement');
    expect(html).toContain('class="doc-type-agreement"');
    expect(html).toContain('Rental agreement preview');
  });

  test('renders the customer onto the page', async () => {
    const { html } = await render({ customerName: 'Γιώργος Παπαδόπουλος' });
    expect(html).toContain('Γιώργος Παπαδόπουλος');
  });

  test('puts the readiness section in once, not twice', async () => {
    // The grid filters the header and readiness sections out and then appends
    // readiness back deliberately. Rendering it twice would print the checks
    // twice on a signed document.
    //
    // Counted on the opening tag rather than on the class name: the stylesheet in
    // the same document also mentions sec-readiness, and a bare substring count
    // finds that too — which is a test that fails on a document that is correct.
    const { html } = await render();
    const sections = html.match(/<section class="doc-section [^"]*sec-readiness/g) || [];
    expect(sections).toHaveLength(1);
  });

  test('does not repeat the header section inside the body grid', async () => {
    // The header is rendered by hand at the top; leaving it in the grid too
    // would print the title twice.
    const { html } = await render();
    expect(html.match(/<section class="doc-section [^"]*sec-header/g) || []).toHaveLength(0);
  });
});

describe('escaping, on a document nobody proof-reads', () => {
  // Every field below comes from a customer or a desk operator. The renderer
  // escapes each one; these say so, per field, because an unescaped value on a
  // document that is rendered to PDF and signed is not a cosmetic problem.
  const PAYLOAD = '<script>alert(1)</script>';

  test('a customer name carrying markup is escaped, not injected', async () => {
    const { html } = await render({ customerName: PAYLOAD });
    expect(html).not.toContain(PAYLOAD);
    expect(html).toContain('&lt;script&gt;');
  });

  test.each([
    ['customerName'],
    ['email'],
    ['phone'],
    ['bookingNumber'],
  ])('%s is escaped', async (field) => {
    const { html } = await render({ [field]: PAYLOAD });
    expect(html).not.toContain(PAYLOAD);
  });

  test('a quote in a field cannot break out of an attribute', async () => {
    const { html } = await render({ customerName: '" onmouseover="alert(1)' });
    expect(html).not.toContain('onmouseover="alert(1)"');
  });

  test('the document still parses as one document after a markup payload', async () => {
    // The give-away for a successful injection: an extra closing tag.
    const { html } = await render({ customerName: '</td></tr></table></section><section>' });
    expect(html.match(/<\/html>/g) || []).toHaveLength(1);
    expect(html.match(/<!doctype html>/gi) || []).toHaveLength(1);
  });

  test('the only script-looking text on the page is escaped', async () => {
    const { html } = await render({ customerName: PAYLOAD, email: PAYLOAD, phone: PAYLOAD });
    expect(html).not.toMatch(/<script/i);
  });

  test('a charge line typed at the desk is escaped in the charges table', async () => {
    // The charges table is the one place on this document where operator-typed
    // text lands in a table cell rather than a key/value row, and it takes a
    // different escaping path through renderSectionHtml.
    const { html } = await render({
      chargeLines: [{ code: PAYLOAD, label: PAYLOAD, category: PAYLOAD, amount: 10 }],
    });
    expect(html).not.toContain(PAYLOAD);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toMatch(/<script/i);
  });

  test('a charge line cannot close the table early and reflow the document', async () => {
    const { html } = await render({
      chargeLines: [{ code: '</td></tr></tbody></table>', label: 'x', category: 'y', amount: 10 }],
    });
    expect(html.match(/<\/html>/g) || []).toHaveLength(1);
    expect(html).toContain('&lt;/td&gt;');
  });
});

// Not asserted, and deliberately: section titles, table headings, key/value
// labels and the readiness blocker strings are all literals in this module
// rather than anything a user supplies, so removing their escapeHtml calls
// changes no output that any input can reach. They are escaped anyway, which is
// right — the moment one of them starts interpolating a record it becomes live —
// but a test claiming to cover it would be asserting on a constant.

// Everything the readiness checks look for: a vehicle, both movement points, and
// a main driver with an identity document.
const COMPLETE = {
  assignedVehicleLabel: 'Hyundai i10 — AAA-1111',
  assignedVehiclePlate: 'AAA-1111',
  pickuppoint: 'Athens Airport',
  dropoffpoint: 'Athens Airport',
  mainDriver: { fullName: 'A Customer', idNo: 'AB123456', licenseNo: 'DL-99887' },
};

describe('readiness travels from the package to the page', () => {
  test('the status shown is the status the model carried', async () => {
    const { printable, html } = await render();
    const status = printable.readiness?.status || 'review';
    expect(html).toContain(`Readiness: ${status}`);
    expect(html).toContain(`class="readiness ${status.toLowerCase()}"`);
  });

  test('an incomplete booking is blocked, and says why', async () => {
    // The seeded booking has no assigned vehicle and no movement details, so it
    // is genuinely not ready to sign. Every blocker the model raised has to be
    // on the page — a blocker computed and then not printed is worse than none.
    const { printable, html } = await render();
    expect(printable.readiness.status).toBe('blocked');
    expect(printable.readiness.blockers.length).toBeGreaterThan(0);
    for (const blocker of printable.readiness.blockers) {
      expect(html).toContain(`<strong>Blocker:</strong> ${blocker}`);
    }
  });

  test('warnings are printed separately from blockers', async () => {
    const { printable, html } = await render();
    expect(printable.readiness.warnings.length).toBeGreaterThan(0);
    for (const warning of printable.readiness.warnings) {
      expect(html).toContain(`<strong>Warning:</strong> ${warning}`);
    }
  });

  test('a blocked document is styled as blocked, not as ready', async () => {
    const { html } = await render();
    expect(html).toContain('class="readiness blocked"');
    expect(html).toContain('Readiness: blocked');
  });

  test('a complete booking reaches ready, and says there is nothing outstanding', async () => {
    // The other half of the branch, and the one the seeded booking never
    // reaches: a vehicle assigned, both movement points set, and a main driver
    // carrying an identity document.
    const { printable, html } = await render(COMPLETE);
    expect(printable.readiness.status).toBe('ready');
    expect(printable.readiness.blockers).toEqual([]);
    expect(printable.readiness.warnings).toEqual([]);
    expect(html).toContain('No blockers.');
    expect(html).toContain('No warnings.');
    expect(html).toContain('class="readiness ready"');
  });

  test('a booking that is only missing an identity document is review, not blocked', async () => {
    // The middle state exists so a desk can tell "cannot sign this" from
    // "check something before you do".
    const { mainDriver: _mainDriver, ...withoutIdentity } = COMPLETE;
    const { printable, html } = await render({ ...withoutIdentity, mainDriver: { fullName: 'A Customer' } });
    expect(printable.readiness.status).toBe('review');
    expect(printable.readiness.blockers).toEqual([]);
    expect(printable.readiness.warnings.length).toBeGreaterThan(0);
    expect(html).toContain('class="readiness review"');
    expect(html).toContain('No blockers.');
  });

  test('the blockers are the ones this booking actually earns, not just some', async () => {
    // Asserted as an exact set. Checking only that "there is at least one
    // blocker and each one is printed" passes just as well when a check stops
    // firing — a car with no vehicle assigned would sail through on the strength
    // of a different blocker still being raised.
    const { printable } = await render();
    expect(printable.readiness.blockers).toEqual([
      'Missing pickup/dropoff movement details.',
      'Missing assigned vehicle.',
    ]);
  });

  test('assigning a vehicle clears exactly that blocker', async () => {
    const { printable } = await render({ assignedVehicleLabel: 'Hyundai i10 — AAA-1111' });
    expect(printable.readiness.blockers).toEqual(['Missing pickup/dropoff movement details.']);
  });

  test('setting both movement points clears exactly that blocker', async () => {
    const { printable } = await render({ pickuppoint: 'Athens Airport', dropoffpoint: 'Athens Airport' });
    expect(printable.readiness.blockers).toEqual(['Missing assigned vehicle.']);
  });

  test('one movement point on its own is not enough', async () => {
    const { printable } = await render({ pickuppoint: 'Athens Airport' });
    expect(printable.readiness.blockers).toContain('Missing pickup/dropoff movement details.');
  });

  test('a driver named but carrying no document is still only a warning', async () => {
    const { printable } = await render({ ...COMPLETE, mainDriver: { fullName: 'A Customer' } });
    expect(printable.readiness.warnings).toEqual(['Main driver identity is incomplete.']);
  });

  test('a licence number counts as identity just as an id number does', async () => {
    const { printable } = await render({ ...COMPLETE, mainDriver: { fullName: 'A Customer', licenseNo: 'DL-99887' } });
    expect(printable.readiness.warnings).toEqual([]);
  });
});

describe('the sections on the page', () => {
  // Asserted against the concrete set this booking produces rather than against
  // "whatever the model happened to contain". A test shaped as "if the model has
  // a financial section, check it" passes just as happily when the section stops
  // being generated at all.
  const EXPECTED_SECTIONS = ['header', 'identity', 'movement', 'vehicle', 'financial', 'charges', 'signature', 'readiness'];

  test('the model carries the sections a rental agreement is made of', async () => {
    const { printable } = await render();
    expect((printable.sections || []).map((s) => String(s.key || '').toLowerCase())).toEqual(EXPECTED_SECTIONS);
  });

  test('every section except the header reaches the page', async () => {
    const { html } = await render();
    for (const key of EXPECTED_SECTIONS.filter((k) => k !== 'header')) {
      expect(html).toContain(`sec-${key}`);
    }
  });

  test('the money sections are laid out full width', async () => {
    // financial and charges are the wide ones; the stylesheet gives them
    // grid-column 1 / -1 and the renderer has to tag them to match.
    const { html } = await render();
    expect(html).toContain('<section class="doc-section financial sec-financial"');
    expect(html).toContain('<section class="doc-section financial sec-charges"');
  });

  test('the signature section is tagged as one', async () => {
    const { html } = await render();
    expect(html).toContain('<section class="doc-section signature sec-signature"');
  });

  test('an ordinary section gets the base tone, not a money one', async () => {
    const { html } = await render();
    expect(html).toContain('<section class="doc-section base sec-identity"');
  });

  test('the charges section renders as a table with its headings', async () => {
    const { printable, html } = await render();
    const charges = (printable.sections || []).find((s) => s.key === 'charges');
    expect(charges.table.columns.length).toBeGreaterThan(0);
    expect(html).toContain('doc-table');
    for (const column of charges.table.columns) {
      expect(html).toContain(String(column));
    }
  });

  test('key/value rows render with their labels', async () => {
    const { printable, html } = await render();
    const identity = (printable.sections || []).find((s) => s.key === 'identity');
    expect(identity.rows.length).toBeGreaterThan(0);
    expect(html).toContain('doc-kv');
    for (const row of identity.rows) {
      expect(html).toContain(`<th>${row.label}</th>`);
    }
  });
});

describe('the money on the document', () => {
  test('the total the customer agreed to appears', async () => {
    const { html } = await render();
    expect(html).toMatch(/171|171[.,]00/);
  });

  test('a booking with no money on it still renders rather than throwing', async () => {
    const { html } = await render({ baseCost: undefined, insuranceCost: undefined, totalPrice: undefined });
    expect(html).toContain('</html>');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
  });

  test('no figure on the page reads as NaN', async () => {
    const { html } = await render({ baseCost: 'free', totalPrice: 'ask' });
    expect(html).not.toContain('NaN');
  });
});

describe('each document type renders', () => {
  test.each([
    ['agreement'],
    ['voucher'],
    ['invoice'],
    ['receipt'],
  ])('%s produces a complete document', async (documentType) => {
    const { html } = await render({}, documentType);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(`class="doc-type-${documentType}"`);
    expect(html).not.toContain('undefined');
  });
});
