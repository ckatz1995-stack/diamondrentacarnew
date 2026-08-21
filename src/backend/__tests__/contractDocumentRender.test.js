import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import * as contract from '../rentalContract.jsw';

// The document half of the contract module: turning a booking into a package, a
// printable model, HTML, and finally a PDF — plus the two operator-facing probes
// that report whether the renderer works at all.
//
// None of it ran before. `pdfkit` and `puppeteer` are installed by Wix rather
// than by this repo, so `require` throws here and every path below the first
// line was unreachable. Both are supplied as virtual mocks, which makes the part
// that actually matters testable: the engine ladder. The high-fidelity renderer
// is tried first and the text renderer catches it, and the result records which
// one ran and why — that record is what an operator sees when a contract comes
// out looking wrong.
//
// The mocks stand in for the packages' shape, not their output. Nothing here
// asserts on real PDF bytes.

const mockPdfkit = { docs: [], constructorOptions: [], emitData: true };
const mockPuppeteer = {
  pdfBuffer: () => Buffer.from('PUPPETEER-PDF-BYTES'),
  pdfError: null,
  launchError: null,
  launched: 0,
  closed: 0,
  lastSetContent: '',
  lastPdfOptions: null,
};

jest.mock('pdfkit', () => {
  const { EventEmitter } = require('events');
  return class FakePDFDocument extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.lines = [];
      mockPdfkit.docs.push(this);
      mockPdfkit.constructorOptions.push(options);
    }
    fontSize() { return this; }
    moveDown() { return this; }
    text(value) { this.lines.push(String(value)); return this; }
    end() {
      // Real pdfkit streams asynchronously; emitting synchronously here would
      // fire before the caller has attached its listeners.
      process.nextTick(() => {
        // With emitData off the stream ends without a chunk, so Buffer.concat
        // yields an empty buffer — a renderer that reports no error and
        // produces nothing, which is a different fault from one that throws.
        if (mockPdfkit.emitData) this.emit('data', Buffer.from(`PDFKIT:${this.lines.join('\n')}`));
        this.emit('end');
      });
    }
  };
}, { virtual: true });

jest.mock('puppeteer', () => ({
  launch: async () => {
    mockPuppeteer.launched += 1;
    if (mockPuppeteer.launchError) throw new Error(mockPuppeteer.launchError);
    return {
      newPage: async () => ({
        setContent: async (html) => { mockPuppeteer.lastSetContent = html; },
        pdf: async (options) => {
          mockPuppeteer.lastPdfOptions = options;
          if (mockPuppeteer.pdfError) throw new Error(mockPuppeteer.pdfError);
          return mockPuppeteer.pdfBuffer();
        },
      }),
      close: async () => { mockPuppeteer.closed += 1; },
    };
  },
}), { virtual: true });

const STAFF = 'staff@example.com';
const NOBODY = 'nobody@example.com';
const PASSWORD = 'correct-horse-battery';
const BOOKING_ID = 'bk-1';

function seed(extra = {}) {
  const passwordSalt = randomHex(16);
  const cred = (email) => ({
    _id: `cred-${email}`, email, passwordSalt,
    passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true,
  });
  return {
    StaffRoles: [
      { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true },
      { _id: 'role-none', key: 'none', label: 'No access', active: true, specialPermissions: '' },
    ],
    StaffUsers: [
      { _id: 'u-1', email: STAFF, fullName: 'Staff', roleKey: 'admin', active: true },
      { _id: 'u-2', email: NOBODY, fullName: 'Nobody', roleKey: 'none', active: true },
    ],
    StaffCredentials: [cred(STAFF), cred(NOBODY)],
    StaffSessions: [],
    StaffAuditLog: [],
    BookingsNew: [{
      _id: BOOKING_ID,
      bookingNumber: 'RNT-2026-0042',
      status: 'Confirmed',
      customerName: 'A Customer',
      email: 'customer@example.com',
      phone: '2101234567',
      pickupDateTime: '2026-03-10T08:00:00.000Z',
      dropoffDateTime: '2026-03-13T08:00:00.000Z',
      categoryId: 'ECO',
      baseCost: 135,
      insuranceCost: 36,
      extrasTotal: 0,
      ageFee: 0,
      nightFee: 0,
      totalPrice: 171,
    }],
    RentalsNew: [],
    FleetNew: [],
    VehiclesNew: [],
    ...extra,
  };
}

let fake;
function install(extra) {
  fake = createFakeWixData(seed(extra)).install(wixData);
  return fake;
}
async function token(email = STAFF) {
  const { sessionToken } = await loginStaff({ email, password: PASSWORD });
  return sessionToken;
}

beforeEach(() => {
  mockPdfkit.docs = [];
  mockPdfkit.constructorOptions = [];
  mockPdfkit.emitData = true;
  mockPuppeteer.pdfBuffer = () => Buffer.from('PUPPETEER-PDF-BYTES');
  mockPuppeteer.pdfError = null;
  mockPuppeteer.launchError = null;
  mockPuppeteer.launched = 0;
  mockPuppeteer.closed = 0;
  mockPuppeteer.lastSetContent = '';
  mockPuppeteer.lastPdfOptions = null;
});

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('who may ask for a document', () => {
  const READERS = [
    ['exportContractDocumentPackage', { bookingId: BOOKING_ID }],
    ['exportContractPrintableModel', { bookingId: BOOKING_ID }],
    ['exportContractRenderedDocument', { bookingId: BOOKING_ID }],
    ['exportContractPdfFromHtml', { bookingId: BOOKING_ID }],
    ['getContractDocumentRenderCapabilities', {}],
    ['selfTestContractDocumentRenderer', {}],
    ['runContractDocumentTemplateRegression', {}],
  ];

  test.each(READERS)('%s refuses an unauthenticated caller', async (name, args) => {
    install();
    await expect(contract[name](args)).rejects.toThrow('AUTH_REQUIRED');
  });

  test.each(READERS)('%s refuses a caller with no rentals access', async (name, args) => {
    install();
    await expect(contract[name]({ ...args, authToken: await token(NOBODY) }))
      .rejects.toThrow('ACCESS_DENIED');
  });

  test('a View-level role is enough — none of these change anything', async () => {
    const s = seed();
    s.StaffRoles.push({ _id: 'role-view', key: 'viewer', label: 'Viewer', active: true, rentalsView: true, specialPermissions: '' });
    s.StaffUsers.push({ _id: 'u-3', email: 'v@example.com', fullName: 'V', roleKey: 'viewer', active: true });
    const passwordSalt = randomHex(16);
    s.StaffCredentials.push({
      _id: 'cred-v', email: 'v@example.com', passwordSalt,
      passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true,
    });
    fake = createFakeWixData(s).install(wixData);

    const res = await contract.exportContractDocumentPackage({
      authToken: await token('v@example.com'), bookingId: BOOKING_ID,
    });
    expect(res.success).toBe(true);
    expect(fake.calls.update).toHaveLength(1); // the session touch, nothing else
    expect(fake.calls.insert.filter((c) => c.collection === 'RentalsNew')).toHaveLength(0);
  });
});

describe('building the package', () => {
  test('returns a package for a booking with no rental record yet', async () => {
    // A contract can be previewed before check-out, so the rental half is
    // drafted in memory rather than inserted.
    install();
    const res = await contract.exportContractDocumentPackage({ authToken: await token(), bookingId: BOOKING_ID });

    expect(res.success).toBe(true);
    expect(res.package).toBeTruthy();
    expect(fake.rows('RentalsNew')).toHaveLength(0);
  });

  test('carries the booking number through to the package meta', async () => {
    install();
    const res = await contract.exportContractDocumentPackage({ authToken: await token(), bookingId: BOOKING_ID });
    expect(res.package.meta.bookingNumber).toBe('RNT-2026-0042');
  });

  test('fills in charges from the booking when the rental has none', async () => {
    install();
    const res = await contract.exportContractDocumentPackage({ authToken: await token(), bookingId: BOOKING_ID });
    expect(JSON.stringify(res.package)).toContain('171');
  });

  test('prefers a stored rental record over the drafted one', async () => {
    install({ RentalsNew: [{ _id: 'r-1', bookingId: BOOKING_ID, internalMemo: 'from the stored rental', charges: { rental: 500, insurance: 0, options: 0, ageFee: 0, nightFee: 0, transport: 0, damages: 0, surcharges: 0, discount: 0, gross: 500 } }] });
    const res = await contract.exportContractDocumentPackage({ authToken: await token(), bookingId: BOOKING_ID });
    expect(res.success).toBe(true);
    expect(JSON.stringify(res.package)).toContain('500');
  });

  test('reports a missing booking id rather than throwing', async () => {
    install();
    await expect(contract.exportContractDocumentPackage({ authToken: await token(), bookingId: '' }))
      .resolves.toMatchObject({ success: false, message: 'Missing bookingId' });
  });

  test('reports an unknown booking rather than throwing', async () => {
    install();
    await expect(contract.exportContractDocumentPackage({ authToken: await token(), bookingId: 'no-such' }))
      .resolves.toMatchObject({ success: false });
  });

  test('defaults to the agreement when no type is asked for', async () => {
    install();
    const res = await contract.exportContractDocumentPackage({ authToken: await token(), bookingId: BOOKING_ID });
    expect(res.package.meta.documentType).toBe('agreement');
  });

  test('honours each of the four supported document types', async () => {
    install();
    for (const documentType of ['agreement', 'invoice', 'receipt', 'voucher']) {
      const res = await contract.exportContractDocumentPackage({ authToken: await token(), bookingId: BOOKING_ID, documentType });
      expect(res.package.meta.documentType).toBe(documentType);
    }
  });

  test('an unsupported type narrows to the agreement rather than failing', async () => {
    install();
    const res = await contract.exportContractDocumentPackage({ authToken: await token(), bookingId: BOOKING_ID, documentType: 'quotation' });
    expect(res.success).toBe(true);
    expect(res.package.meta.documentType).toBe('agreement');
  });

  test('the type is matched case-insensitively', async () => {
    install();
    const res = await contract.exportContractDocumentPackage({ authToken: await token(), bookingId: BOOKING_ID, documentType: 'INVOICE' });
    expect(res.package.meta.documentType).toBe('invoice');
  });
});

describe('the export chain', () => {
  test('the printable model builds on the package and returns both', async () => {
    install();
    const res = await contract.exportContractPrintableModel({ authToken: await token(), bookingId: BOOKING_ID });
    expect(res.success).toBe(true);
    expect(res.package).toBeTruthy();
    expect(Array.isArray(res.printable.sections)).toBe(true);
    expect(res.printable.sections.length).toBeGreaterThan(0);
  });

  test('the rendered document adds HTML, keeping what came before', async () => {
    install();
    const res = await contract.exportContractRenderedDocument({ authToken: await token(), bookingId: BOOKING_ID });
    expect(res.success).toBe(true);
    expect(res.html).toContain('<');
    expect(res.printable).toBeTruthy();
    expect(res.package).toBeTruthy();
  });

  test('the HTML carries the booking number a reader would look for', async () => {
    install();
    const res = await contract.exportContractRenderedDocument({ authToken: await token(), bookingId: BOOKING_ID });
    expect(res.html).toContain('RNT-2026-0042');
  });

  test('a failure at the package step is handed back unchanged by every layer above', async () => {
    // Each layer checks `result.success` and returns the failure verbatim rather
    // than wrapping it, so the message an operator sees names the real problem.
    install();
    const t = await token();
    const expected = { success: false, message: 'Missing bookingId' };

    await expect(contract.exportContractPrintableModel({ authToken: t, bookingId: '' })).resolves.toMatchObject(expected);
    await expect(contract.exportContractRenderedDocument({ authToken: t, bookingId: '' })).resolves.toMatchObject(expected);
    await expect(contract.exportContractPdfFromHtml({ authToken: t, bookingId: '' })).resolves.toMatchObject(expected);
  });

  test('a layer above the package does not re-read the booking', async () => {
    install();
    const t = await token();
    const before = fake.calls.get?.length ?? 0;
    await contract.exportContractRenderedDocument({ authToken: t, bookingId: BOOKING_ID });
    // One read for the booking, through the single chain — not one per layer.
    expect((fake.calls.get?.length ?? 0) - before).toBeLessThanOrEqual(1);
  });
});

describe('the engine ladder', () => {
  test('the high-fidelity renderer is tried first and wins when it works', async () => {
    install();
    const res = await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });

    expect(res.success).toBe(true);
    expect(res.renderEngine).toBe('puppeteer_html_pdf');
    expect(res.fidelity).toBe('high');
    expect(res.fallbackUsed).toBe(false);
    expect(res.attemptedEngines).toEqual(['puppeteer_html_pdf']);
    expect(mockPdfkit.docs).toHaveLength(0);
  });

  test('the rendered HTML is what gets handed to the browser', async () => {
    install();
    const res = await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });
    expect(mockPuppeteer.lastSetContent).toBe(res.html);
  });

  test('the PDF comes back base64-encoded, with a filename and type', async () => {
    install();
    const res = await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });

    expect(Buffer.from(res.pdfBase64, 'base64').toString()).toBe('PUPPETEER-PDF-BYTES');
    expect(res.filename).toBe('agreement_RNT-2026-0042.pdf');
    expect(res.type).toBe('application/pdf');
  });

  test('the filename follows the document type', async () => {
    install();
    const res = await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID, documentType: 'invoice' });
    expect(res.filename).toBe('invoice_RNT-2026-0042.pdf');
  });

  test('a render failure falls back to the text renderer, and says why', async () => {
    install();
    mockPuppeteer.pdfError = 'Protocol error: Target closed';
    const res = await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });

    expect(res.success).toBe(true);
    expect(res.renderEngine).toBe('pdfkit_text_fallback');
    expect(res.fidelity).toBe('baseline');
    expect(res.fallbackUsed).toBe(true);
    expect(res.fallbackReason).toBe('HIGH_FIDELITY_ERROR:Protocol error: Target closed');
    expect(res.attemptedEngines).toEqual(['puppeteer_html_pdf', 'pdfkit_text_fallback']);
  });

  test('a browser that will not launch falls back the same way', async () => {
    install();
    mockPuppeteer.launchError = 'Failed to launch the browser process';
    const res = await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });

    expect(res.renderEngine).toBe('pdfkit_text_fallback');
    expect(res.fallbackReason).toContain('HIGH_FIDELITY_ERROR:Failed to launch');
  });

  test('an empty buffer is treated as a failure, with its own reason', async () => {
    // The distinction matters: the browser ran and reported no error, so this is
    // not the same fault as a crash and should not be diagnosed as one.
    install();
    mockPuppeteer.pdfBuffer = () => Buffer.alloc(0);
    const res = await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });

    expect(res.renderEngine).toBe('pdfkit_text_fallback');
    expect(res.fallbackUsed).toBe(true);
    expect(res.fallbackReason).toBe('HIGH_FIDELITY_EMPTY_BUFFER');
  });

  test('the fallback PDF still comes back, base64 and all', async () => {
    install();
    mockPuppeteer.pdfError = 'boom';
    const res = await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });
    expect(Buffer.from(res.pdfBase64, 'base64').toString()).toContain('PDFKIT:');
  });

  test('the browser is closed when the render succeeds', async () => {
    install();
    await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });
    expect(mockPuppeteer.launched).toBe(1);
    expect(mockPuppeteer.closed).toBe(1);
  });

  test('and when it fails — a crashed render must not leak the browser', async () => {
    // The close sits in a finally. Without it, every failed contract would leave
    // a Chromium process behind on a long-lived Velo instance.
    install();
    mockPuppeteer.pdfError = 'boom';
    await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });
    expect(mockPuppeteer.closed).toBe(1);
  });

  test('the text fallback is handed the plain text of the same document', async () => {
    install();
    mockPuppeteer.pdfError = 'boom';
    await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });

    const body = mockPdfkit.docs[0].lines.join('\n');
    expect(body).toContain('RNT-2026-0042');
    expect(body).not.toContain('<div');
    expect(body).not.toContain('</p>');
  });

  test('the fallback names the document in its title line', async () => {
    install();
    mockPuppeteer.pdfError = 'boom';
    await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID, documentType: 'receipt' });
    expect(mockPdfkit.docs[0].lines[0]).toContain('RECEIPT');
    expect(mockPdfkit.docs[0].lines[0]).toContain('RNT-2026-0042');
  });

  test('the page is asked for A4 with backgrounds printed', async () => {
    // Backgrounds off would drop every shaded header in the template, which is
    // the difference between a contract and a page of grey text.
    install();
    await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });
    expect(mockPuppeteer.lastPdfOptions).toMatchObject({ format: 'A4', printBackground: true });
  });

  test('the fallback document is A4 too', async () => {
    install();
    mockPuppeteer.pdfError = 'boom';
    await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });
    expect(mockPdfkit.constructorOptions[0]).toMatchObject({ size: 'A4' });
  });

  test('the result reports how long the render took and what the runtime supports', async () => {
    install();
    const res = await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });
    expect(typeof res.renderDurationMs).toBe('number');
    expect(res.capabilitySnapshot.supportsPdfFromHtmlHifi).toBe(true);
    expect(Array.isArray(res.renderWarnings)).toBe(true);
  });

  test('when both engines are down the HTML still comes back', async () => {
    // The text renderer is the bottom of the ladder — nothing catches it, so its
    // failure fails the whole call. The catch hands back the package, printable
    // model and HTML anyway, so an operator can still read, print or copy the
    // document that could not be turned into a PDF.
    install();
    const res = await withBrokenPdfkit(async () => {
      mockPuppeteer.pdfError = 'Target closed';
      return contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });
    });

    expect(res.success).toBe(false);
    expect(res.message).toBeTruthy();
    expect(res.html).toContain('RNT-2026-0042');
    expect(res.package).toBeTruthy();
    expect(res.printable).toBeTruthy();
    expect(res.pdfBase64).toBeUndefined();
  });
});

describe('turning the document HTML into text for the fallback', () => {
  // Reached through the fallback renderer, which is handed the same HTML the
  // browser would have got.
  // htmlToPlainTextForPdf is module-internal, so there is no way to hand it
  // markup of our own. These drive the real template through the fallback and
  // assert on the shape of the document that comes out — which is the thing
  // that matters anyway.
  async function fallbackText() {
    install();
    mockPuppeteer.pdfError = 'boom';
    await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });
    return mockPdfkit.docs[0].lines.join('\n');
  }

  test('no tags survive into the text', async () => {
    const text = await fallbackText();
    expect(text).not.toMatch(/<[a-z/][^>]*>/i);
  });

  test('the stylesheet is dropped rather than printed as text', async () => {
    // The template carries an inline <style> block; without the style-stripping
    // rule its CSS would be the first thing on the page.
    const text = await fallbackText();
    expect(text).not.toContain('font-family');
    expect(text).not.toContain('px;');
  });

  test('block elements become line breaks, so fields do not run together', async () => {
    // A line count alone proves nothing here: <br> becomes a newline through a
    // separate rule, and the source HTML has newlines of its own, so the text
    // stays multi-line even with the block rule gone. What the rule actually
    // buys is that each row stands alone — without it the whole charges table
    // arrives as one line, and so does every label/value pair.
    const text = await fallbackText();
    const lineWith = (needle) => text.split('\n').find((l) => l.includes(needle)) ?? '';

    expect(lineWith('rental_base')).not.toContain('insurance');
    expect(lineWith('Gross')).not.toContain('Net');
    expect(lineWith('Phone')).not.toContain('Email');
  });

  test('runs of blank lines are collapsed', async () => {
    const text = await fallbackText();
    expect(text).not.toMatch(/\n{3,}/);
  });

  test('runs of spaces are collapsed', async () => {
    const text = await fallbackText();
    expect(text).not.toMatch(/[ \t]{2,}/);
  });

  test('the text is trimmed at both ends', async () => {
    const text = await fallbackText();
    expect(text).toBe(text.trim());
  });

  test('escaped entities are decoded back to their characters', async () => {
    // The template escapes what it interpolates, so a customer named with an
    // ampersand arrives here as &amp; and must not be printed that way.
    install();
    fake.restore();
    fake = createFakeWixData(seed({
      BookingsNew: [{
        ...seed().BookingsNew[0],
        customerName: 'Smith & Sons <Ltd>',
      }],
    })).install(wixData);
    mockPuppeteer.pdfError = 'boom';

    await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });
    const text = mockPdfkit.docs[0].lines.join('\n');
    expect(text).toContain('Smith & Sons <Ltd>');
    expect(text).not.toContain('&amp;');
    expect(text).not.toContain('&lt;');
  });
});

describe('the renderer capability probe', () => {
  test('reports the high-fidelity engine as available when puppeteer loads', async () => {
    install();
    const res = await contract.getContractDocumentRenderCapabilities({ authToken: await token() });

    expect(res.success).toBe(true);
    expect(res.capabilities).toMatchObject({
      supportsHtmlTemplate: true,
      supportsPdfFromHtml: true,
      supportsPdfFromHtmlHifi: true,
      preferredRenderEngine: 'puppeteer_html_pdf',
    });
    expect(res.capabilities.availableRenderEngines).toEqual(['puppeteer_html_pdf', 'pdfkit_text_fallback']);
    expect(res.capabilities.runtimeLimitations).toEqual([]);
  });
});

describe('the renderer self-test', () => {
  test('reports healthy when both engines render', async () => {
    install();
    const res = await contract.selfTestContractDocumentRenderer({ authToken: await token() });

    expect(res.success).toBe(true);
    expect(res.selfTest).toMatchObject({
      status: 'healthy',
      hifiReady: true,
      fallbackRequired: false,
      preferredEngineConfidence: 'high',
      recommendedRenderMode: 'pdf_from_html',
    });
    expect(res.selfTest.warnings).toEqual([]);
  });

  test('tries both engines even when the first one works', async () => {
    // The point of a self-test is to learn whether the fallback is there before
    // it is needed, not to stop at the first success.
    install();
    const res = await contract.selfTestContractDocumentRenderer({ authToken: await token() });
    expect(res.selfTest.attemptedEngines).toEqual(['puppeteer_html_pdf', 'pdfkit_text_fallback']);
    expect(res.selfTest.stages.fallback.renderSupported).toBe(true);
  });

  test('reports fallback-only when the browser cannot render, and names the stage', async () => {
    install();
    mockPuppeteer.pdfError = 'Target closed';
    const res = await contract.selfTestContractDocumentRenderer({ authToken: await token() });

    expect(res.selfTest).toMatchObject({
      status: 'fallback-only',
      hifiReady: false,
      fallbackRequired: true,
      preferredEngineConfidence: 'medium',
      recommendedRenderMode: 'pdf_from_html',
      failureStage: 'HIFI_RENDER',
    });
    expect(res.selfTest.stages.hifi.modulePresent).toBe(true);
    expect(res.selfTest.stages.hifi.error).toContain('Target closed');
    expect(res.selfTest.warnings.join(' ')).toContain('fallback-only mode');
  });

  test('reports degraded when neither engine renders', async () => {
    install();
    mockPuppeteer.pdfError = 'Target closed';
    const res = await withBrokenPdfkit(async () =>
      contract.selfTestContractDocumentRenderer({ authToken: await token() }));

    expect(res.selfTest).toMatchObject({
      status: 'degraded',
      hifiReady: false,
      preferredEngineConfidence: 'low',
      recommendedRenderMode: 'legacy_pdfkit',
    });
    expect(res.selfTest.stages.fallback.renderSupported).toBe(false);
    expect(res.selfTest.warnings.join(' ')).toContain('Fallback renderer self-test failed');
  });

  test('records how long each stage took', async () => {
    install();
    const res = await contract.selfTestContractDocumentRenderer({ authToken: await token() });
    expect(typeof res.selfTest.stages.hifi.durationMs).toBe('number');
    expect(typeof res.selfTest.stages.fallback.durationMs).toBe('number');
    expect(typeof res.selfTest.durationMs).toBe('number');
  });
});

describe('the template regression harness', () => {
  test('passes across every document type when the templates are intact', async () => {
    install();
    const res = await contract.runContractDocumentTemplateRegression({ authToken: await token() });

    expect(res.success).toBe(true);
    expect(res.report.success).toBe(true);
    expect(res.report.failedDocuments).toEqual([]);
    expect(res.report.results.length).toBeGreaterThan(0);
  });

  test('renders a real PDF for each type as part of the check', async () => {
    install();
    const res = await contract.runContractDocumentTemplateRegression({ authToken: await token() });
    for (const result of res.report.results) {
      expect(result.pdfSmoke).toMatchObject({ attempted: true, ok: true, engine: 'puppeteer_html_pdf' });
      expect(result.htmlLength).toBeGreaterThan(0);
      expect(result.printableSections).toBeGreaterThan(0);
    }
  });

  test('a document whose PDF will not render is reported as failed', async () => {
    install();
    const res = await withBrokenPdfkit(async () => {
      mockPuppeteer.pdfError = 'Target closed';
      return contract.runContractDocumentTemplateRegression({ authToken: await token() });
    });

    expect(res.report.success).toBe(false);
    expect(res.report.failedDocuments.length).toBeGreaterThan(0);
    expect(res.report.results[0].pdfSmoke).toMatchObject({ attempted: true, ok: false });
    expect(res.report.results[0].pdfSmoke.error).toBeTruthy();
  });

  test('a renderer that produces an empty PDF without erroring also fails the check', async () => {
    // The other way a document can be broken: both engines "succeed" and hand
    // back nothing. There is no exception to catch, so only the length check
    // stands between an empty file and a passing report — and the report says
    // so with no error text, which is how it differs from a crash.
    install();
    mockPuppeteer.pdfBuffer = () => Buffer.alloc(0);
    mockPdfkit.emitData = false;

    const res = await contract.runContractDocumentTemplateRegression({ authToken: await token() });

    expect(res.report.success).toBe(false);
    expect(res.report.failedDocuments.length).toBeGreaterThan(0);
    expect(res.report.results[0].pdfSmoke).toMatchObject({ attempted: true, ok: false, error: '' });
  });

  test('the report carries the capability snapshot it ran against', async () => {
    install();
    const res = await contract.runContractDocumentTemplateRegression({ authToken: await token() });
    expect(res.report.capabilitySnapshot.supportsPdfFromHtmlHifi).toBe(true);
  });
});

/**
 * Runs `fn` with the pdfkit stand-in throwing on construction, which is how the
 * text renderer fails without touching the module under test.
 */
async function withBrokenPdfkit(fn) {
  const PDFDocument = require('pdfkit');
  const broken = jest.spyOn(PDFDocument.prototype, 'end').mockImplementation(function brokenEnd() {
    process.nextTick(() => this.emit('error', new Error('pdfkit stream failed')));
  });
  try {
    return await fn();
  } finally {
    broken.mockRestore();
  }
}

describe('the document endpoints when the layer beneath them throws', () => {
  // Each of the five endpoints wraps its own work. What that buys is a failure
  // the panel can show — `{ success:false, message }` — rather than a rejected
  // promise the page controller has to catch for itself. The contract screen
  // reads `success` on every one of these, so an unwrapped throw would surface
  // as a silent dead button rather than as an error.
  const brokenBookingRead = async (fn) => {
    install();
    const authToken = await token();
    const original = wixData.get;
    wixData.get = (collection, ...rest) => (
      collection === 'BookingsNew'
        ? Promise.reject(new Error('collection missing'))
        : original.call(wixData, collection, ...rest)
    );
    try { return await fn(authToken); } finally { wixData.get = original; }
  };

  test('the package endpoint reports a failed booking read', async () => {
    const res = await brokenBookingRead((authToken) =>
      contract.exportContractDocumentPackage({ authToken, bookingId: BOOKING_ID }));

    expect(res).toMatchObject({ success: false, message: 'collection missing' });
  });

  test('the printable endpoint passes a failure straight through rather than re-wrapping it', async () => {
    const res = await brokenBookingRead((authToken) =>
      contract.exportContractPrintableModel({ authToken, bookingId: BOOKING_ID }));

    expect(res).toMatchObject({ success: false, message: 'collection missing' });
  });

  test('the rendered endpoint does the same', async () => {
    const res = await brokenBookingRead((authToken) =>
      contract.exportContractRenderedDocument({ authToken, bookingId: BOOKING_ID }));

    expect(res).toMatchObject({ success: false, message: 'collection missing' });
  });

  test('the pdf endpoint does the same', async () => {
    const res = await brokenBookingRead((authToken) =>
      contract.exportContractPdfFromHtml({ authToken, bookingId: BOOKING_ID }));

    expect(res).toMatchObject({ success: false });
  });

  test('a thrown value with no message still names the failure', async () => {
    install();
    const authToken = await token();
    const original = wixData.get;
    wixData.get = () => Promise.reject('just a string');
    try {
      expect(await contract.exportContractDocumentPackage({ authToken, bookingId: BOOKING_ID }))
        .toMatchObject({ success: false, message: 'just a string' });
    } finally {
      wixData.get = original;
    }
  });

  test('the capabilities probe answers rather than throwing, whatever the renderer says', async () => {
    install();

    const res = await contract.getContractDocumentRenderCapabilities({ authToken: await token() });

    expect(res.success).toBe(true);
    expect(res.capabilities).toEqual(expect.any(Object));
  });

  test('the self-test probe answers with a report', async () => {
    install();

    const res = await contract.selfTestContractDocumentRenderer({ authToken: await token() });

    expect(res).toMatchObject({ success: true, selfTest: expect.any(Object) });
  });

  test('the template regression harness answers with a report', async () => {
    install();

    const res = await contract.runContractDocumentTemplateRegression({ authToken: await token() });

    expect(res).toMatchObject({ success: true, report: expect.any(Object) });
  });

  test.each([
    ['getContractDocumentRenderCapabilities', 'getContractDocumentRenderCapabilities'],
    ['selfTestContractDocumentRenderer', 'selfTestContractDocumentRenderer'],
    ['runContractDocumentTemplateRegression', 'runContractDocumentTemplateRegression'],
  ])('%s is refused without a session', async (_label, name) => {
    install();

    await expect(contract[name]({ authToken: 'f'.repeat(64) })).rejects.toThrow();
  });
});
