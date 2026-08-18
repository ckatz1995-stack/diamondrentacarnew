import wixData from 'wix-data';
import * as secrets from 'wix-secrets-backend';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import { saveContract } from '../rentalContract.jsw';

// The tail of saveContract's checkout stage: render the contract and email it.
// It is the only place in the codebase that sends a customer their paperwork,
// and it decides the recipient list — so getting it wrong means a contract in
// the wrong inbox, or in none.
//
// It never ran before. pdfkit, puppeteer and @sendgrid/mail are installed by
// Wix rather than by this repo, so the first `require` threw and the block was
// covered only by the guarantee that its failure cannot cost you the save
// (pinned in saveContract.test.js, which deliberately leaves them absent).
// Here all three are supplied as virtual mocks so the block itself can run.

const mockPdfkit = { docs: [], failNextConstructions: 0 };
const mockSendgrid = { apiKeys: [], sent: [], sendError: null };
const mockPuppeteer = { pdfError: null };

jest.mock('pdfkit', () => {
  const { EventEmitter } = require('events');
  return class FakePDFDocument extends EventEmitter {
    constructor(options) {
      super();
      // Lets a test fail the adapter's renderer while leaving the nested legacy
      // one working — the only way to reach the fallback-inside-the-fallback.
      if (mockPdfkit.failNextConstructions > 0) {
        mockPdfkit.failNextConstructions -= 1;
        throw new Error('pdfkit unavailable');
      }
      this.options = options;
      this.lines = [];
      mockPdfkit.docs.push(this);
    }
    fontSize() { return this; }
    moveDown() { return this; }
    text(value) { this.lines.push(String(value)); return this; }
    end() {
      process.nextTick(() => {
        this.emit('data', Buffer.from(`PDFKIT:${this.lines.join('\n')}`));
        this.emit('end');
      });
    }
  };
}, { virtual: true });

jest.mock('puppeteer', () => ({
  launch: async () => ({
    newPage: async () => ({
      setContent: async () => {},
      pdf: async () => {
        if (mockPuppeteer.pdfError) throw new Error(mockPuppeteer.pdfError);
        return Buffer.from('PUPPETEER-PDF-BYTES');
      },
    }),
    close: async () => {},
  }),
}), { virtual: true });

jest.mock('@sendgrid/mail', () => ({
  setApiKey: (key) => { mockSendgrid.apiKeys.push(key); },
  send: async (message) => {
    if (mockSendgrid.sendError) throw new Error(mockSendgrid.sendError);
    mockSendgrid.sent.push(message);
    return [{ statusCode: 202 }];
  },
}), { virtual: true });

const STAFF = 'staff@example.com';
const PASSWORD = 'correct-horse-battery';
const BOOKING_ID = 'bk-1';
const CUSTOMER_EMAIL = 'customer@example.com';
const OPS_EMAIL = 'ops@diamond.example';
const FROM_EMAIL = 'noreply@diamond.example';
const API_KEY = 'SG.test-key';

const SECRETS = { SENDGRID_API_KEY: API_KEY, FROM_EMAIL, OPS_EMAIL };
let secretValues;
let originalGetSecret;

function seed(bookingExtra = {}) {
  const passwordSalt = randomHex(16);
  return {
    StaffRoles: [{ _id: 'role-admin', key: 'admin', label: 'Administrator', active: true }],
    StaffUsers: [{ _id: 'u-1', email: STAFF, fullName: 'Staff', roleKey: 'admin', active: true }],
    StaffCredentials: [{
      _id: 'cred-1', email: STAFF, passwordSalt,
      passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true,
    }],
    StaffSessions: [],
    StaffAuditLog: [],
    BookingsNew: [{
      _id: BOOKING_ID,
      bookingNumber: 'RNT-2026-0042',
      status: 'Confirmed',
      customerName: 'A Customer',
      email: CUSTOMER_EMAIL,
      phone: '2101234567',
      pickupDateTime: '2026-03-10T08:00:00.000Z',
      dropoffDateTime: '2026-03-13T08:00:00.000Z',
      categoryId: 'ECO',
      baseCost: 135, insuranceCost: 36, extrasTotal: 0, ageFee: 0, nightFee: 0, totalPrice: 171,
      ...bookingExtra,
    }],
    RentalsNew: [],
    FleetNew: [],
    VehiclesNew: [],
  };
}

let fake;
function install(bookingExtra) {
  fake = createFakeWixData(seed(bookingExtra)).install(wixData);
  return fake;
}
async function token() {
  const { sessionToken } = await loginStaff({ email: STAFF, password: PASSWORD });
  return sessionToken;
}
/** Saves at the checkout stage, which is the only stage that renders and sends. */
async function checkout(payload = {}) {
  return saveContract({ authToken: await token(), bookingId: BOOKING_ID, payload, stage: 'checkout' });
}
const bookingRow = () => fake.rows('BookingsNew').find((b) => b._id === BOOKING_ID);
const rentalRow = () => fake.rows('RentalsNew').find((r) => r.bookingId === BOOKING_ID);
const lastMessage = () => mockSendgrid.sent[mockSendgrid.sent.length - 1];
const lastAttachment = () => lastMessage().attachments[0];

beforeAll(() => {
  originalGetSecret = secrets.getSecret;
});

beforeEach(() => {
  mockPdfkit.docs = [];
  mockPdfkit.failNextConstructions = 0;
  mockSendgrid.apiKeys = [];
  mockSendgrid.sent = [];
  mockSendgrid.sendError = null;
  mockPuppeteer.pdfError = null;
  secretValues = { ...SECRETS };
  secrets.getSecret = jest.fn(async (name) => secretValues[name]);
});

afterEach(() => {
  secrets.getSecret = originalGetSecret;
  if (fake) fake.restore();
  fake = null;
});

describe('when the contract is sent at all', () => {
  test('a checkout save renders and sends', async () => {
    install();
    const res = await checkout();

    expect(res.success).toBe(true);
    expect(res.warning).toBeUndefined();
    expect(mockSendgrid.sent).toHaveLength(1);
  });

  test('no other stage sends anything', async () => {
    install();
    const t = await token();
    for (const stage of ['pre', 'final', 'whatever', undefined]) {
      await saveContract({ authToken: t, bookingId: BOOKING_ID, payload: {}, stage });
    }
    expect(mockSendgrid.sent).toHaveLength(0);
    expect(mockPdfkit.docs).toHaveLength(0);
  });

  test('the records are written before anything is rendered', async () => {
    // The order is what makes the whole block optional: a broken renderer or a
    // dead SendGrid cannot undo a check-out that already happened.
    install();
    mockSendgrid.sendError = 'SendGrid is down';
    const res = await checkout({ charges: { rental: 135, insurance: 36, damages: 40 } });

    expect(res.success).toBe(true);
    expect(res.warning).toContain('SendGrid is down');
    expect(rentalRow().rentalState).toBe('Active Rental');
    expect(bookingRow().rentalState).toBe('Active Rental');
    expect(bookingRow().totalPrice).toBe(211);
  });
});

describe('who receives it', () => {
  test('the ops mailbox and the customer', async () => {
    install();
    await checkout();
    expect(lastMessage().to).toEqual([OPS_EMAIL, CUSTOMER_EMAIL]);
  });

  test('ops alone when the booking has no customer email', async () => {
    install({ email: '' });
    await checkout();
    expect(lastMessage().to).toEqual([OPS_EMAIL]);
  });

  test('a whitespace-only customer email does not become a recipient', async () => {
    install({ email: '   ' });
    await checkout();
    expect(lastMessage().to).toEqual([OPS_EMAIL]);
  });

  test('the customer address is trimmed before it is used', async () => {
    install({ email: `  ${CUSTOMER_EMAIL}  ` });
    await checkout();
    expect(lastMessage().to).toEqual([OPS_EMAIL, CUSTOMER_EMAIL]);
  });

  test('the from address is the configured one, not the ops mailbox', async () => {
    install();
    await checkout();
    expect(lastMessage().from).toBe(FROM_EMAIL);
  });

  test('the api key from the vault is the one handed to SendGrid', async () => {
    install();
    await checkout();
    expect(mockSendgrid.apiKeys).toEqual([API_KEY]);
  });

  test('the subject and body name the booking', async () => {
    install();
    await checkout();
    expect(lastMessage().subject).toContain('RNT-2026-0042');
    expect(lastMessage().text).toContain('RNT-2026-0042');
  });

  test('a booking with no number falls back to its id', async () => {
    install({ bookingNumber: '' });
    await checkout();
    expect(lastMessage().subject).toContain(BOOKING_ID);
  });
});

describe('the default render mode', () => {
  test('produces a PDF through the text renderer', async () => {
    install();
    const res = await checkout();

    expect(res.renderDiagnostics).toMatchObject({
      mode: 'legacy_pdfkit',
      engine: 'legacy_pdfkit',
      fidelity: 'legacy',
      fallbackUsed: false,
      fallbackReason: '',
      attemptedEngines: ['legacy_pdfkit'],
    });
  });

  test('the browser is never involved', async () => {
    install();
    await checkout();
    expect(mockPdfkit.docs).toHaveLength(1);
  });

  test('the attachment is a PDF named for the booking', async () => {
    install();
    await checkout();

    expect(lastAttachment()).toMatchObject({
      filename: 'Receipt_RNT-2026-0042.pdf',
      type: 'application/pdf',
      disposition: 'attachment',
    });
    expect(Buffer.from(lastAttachment().content, 'base64').toString()).toContain('PDFKIT:');
  });

  test('the document carries the details an operator would check', async () => {
    install();
    await checkout({ charges: { rental: 135, insurance: 36 } });
    const body = mockPdfkit.docs[0].lines.join('\n');

    expect(body).toContain('RNT-2026-0042');
    expect(body).toContain('A Customer');
    expect(body).toContain(CUSTOMER_EMAIL);
    expect(body).toContain('171');
  });

  test('the render mode is matched case-insensitively', async () => {
    // Only documentType's case fold was covered before; the mode has its own.
    install();
    const res = await checkout({ documentRenderMode: 'PDF_From_HTML' });
    expect(res.renderDiagnostics.mode).toBe('pdf_from_html');
    expect(res.renderDiagnostics.engine).toBe('puppeteer_html_pdf');
  });

  test('an unrecognised render mode falls into this path rather than failing', async () => {
    install();
    const res = await checkout({ documentRenderMode: 'interpretive_dance' });
    expect(res.renderDiagnostics.mode).toBe('legacy_pdfkit');
    expect(mockSendgrid.sent).toHaveLength(1);
  });
});

describe('the html_template render mode', () => {
  test('attaches the document as HTML rather than a PDF', async () => {
    install();
    const res = await checkout({ documentRenderMode: 'html_template' });

    expect(res.renderDiagnostics).toMatchObject({
      mode: 'html_template',
      engine: 'html_attachment',
      fidelity: 'html',
      fallbackUsed: false,
      attemptedEngines: ['html_attachment'],
    });
    expect(lastAttachment()).toMatchObject({
      filename: 'receipt_RNT-2026-0042.html',
      type: 'text/html',
      disposition: 'attachment',
    });
  });

  test('nothing is rendered to PDF at all', async () => {
    install();
    await checkout({ documentRenderMode: 'html_template' });
    expect(mockPdfkit.docs).toHaveLength(0);
  });

  test('the attached HTML is the rendered contract', async () => {
    install();
    await checkout({ documentRenderMode: 'html_template' });
    const html = Buffer.from(lastAttachment().content, 'base64').toString('utf8');

    expect(html).toContain('RNT-2026-0042');
    expect(html).toContain('A Customer');
    expect(html).toContain('<');
  });

  test('the document type defaults to a receipt, not the agreement', async () => {
    // Everywhere else in this module an unspecified document type means
    // 'agreement'. This block is the exception, and the filename is where it
    // shows.
    install();
    await checkout({ documentRenderMode: 'html_template' });
    expect(lastAttachment().filename).toBe('receipt_RNT-2026-0042.html');
  });

  test('a requested document type is honoured, and lower-cased', async () => {
    install();
    await checkout({ documentRenderMode: 'html_template', documentType: 'INVOICE' });
    expect(lastAttachment().filename).toBe('invoice_RNT-2026-0042.html');
  });
});

describe('the pdf_from_html render mode', () => {
  test('renders through the browser and reports the engine that ran', async () => {
    install();
    const res = await checkout({ documentRenderMode: 'pdf_from_html' });

    expect(res.renderDiagnostics).toMatchObject({
      mode: 'pdf_from_html',
      engine: 'puppeteer_html_pdf',
      fidelity: 'high',
      fallbackUsed: false,
      attemptedEngines: ['puppeteer_html_pdf'],
    });
    expect(res.renderDiagnostics.capabilitySnapshot.supportsPdfFromHtmlHifi).toBe(true);
    expect(typeof res.renderDiagnostics.durationMs).toBe('number');
  });

  test('the attachment is the browser-rendered PDF, named for the document type', async () => {
    install();
    await checkout({ documentRenderMode: 'pdf_from_html', documentType: 'agreement' });

    expect(lastAttachment()).toMatchObject({
      filename: 'agreement_RNT-2026-0042.pdf',
      type: 'application/pdf',
      // Asserted on every branch, not just the legacy one: an inlined contract
      // renders in the mail body instead of arriving as a file to keep.
      disposition: 'attachment',
    });
    expect(Buffer.from(lastAttachment().content, 'base64').toString()).toBe('PUPPETEER-PDF-BYTES');
  });

  test('a browser failure drops to the text renderer, still inside the adapter', async () => {
    install();
    mockPuppeteer.pdfError = 'Target closed';
    const res = await checkout({ documentRenderMode: 'pdf_from_html' });

    expect(res.renderDiagnostics).toMatchObject({
      mode: 'pdf_from_html',
      engine: 'pdfkit_text_fallback',
      fidelity: 'baseline',
      fallbackUsed: true,
    });
    expect(res.renderDiagnostics.fallbackReason).toContain('HIGH_FIDELITY_ERROR');
    expect(lastAttachment().filename).toBe('receipt_RNT-2026-0042.pdf');
  });

  test('an adapter that fails outright falls back again, to the legacy document', async () => {
    // The fallback inside the fallback: both engines in the adapter are gone, so
    // the block builds the plain legacy PDF instead of giving up. Reaching it
    // needs the adapter's pdfkit to fail while the legacy one still works, hence
    // the one-shot constructor failure.
    install();
    mockPuppeteer.pdfError = 'Target closed';
    mockPdfkit.failNextConstructions = 1;

    const res = await checkout({ documentRenderMode: 'pdf_from_html' });

    expect(res.success).toBe(true);
    expect(res.renderDiagnostics).toMatchObject({
      mode: 'pdf_from_html',
      engine: 'legacy_pdfkit_fallback',
      fidelity: 'legacy',
      fallbackUsed: true,
      fallbackReason: 'PDF_FROM_HTML_ADAPTER_FAILED',
      durationMs: 0,
    });
    expect(res.renderDiagnostics.attemptedEngines)
      .toEqual(['puppeteer_html_pdf', 'pdfkit_text_fallback', 'legacy_pdfkit']);
  });

  test('and that last-ditch document is still attached and sent', async () => {
    install();
    mockPuppeteer.pdfError = 'Target closed';
    mockPdfkit.failNextConstructions = 1;
    await checkout({ documentRenderMode: 'pdf_from_html' });

    expect(mockSendgrid.sent).toHaveLength(1);
    expect(lastAttachment()).toMatchObject({ filename: 'Receipt_RNT-2026-0042.pdf', type: 'application/pdf' });
    expect(Buffer.from(lastAttachment().content, 'base64').toString()).toContain('RNT-2026-0042');
  });

  test('when even that fails the save still stands, with a warning', async () => {
    install();
    mockPuppeteer.pdfError = 'Target closed';
    mockPdfkit.failNextConstructions = 2;

    const res = await checkout();
    expect(res.success).toBe(true);
    expect(res.warning).toContain('PDF/email failed');
    expect(rentalRow().rentalState).toBe('Active Rental');
    expect(mockSendgrid.sent).toHaveLength(0);
  });
});

describe('the vault secrets', () => {
  test('all three are read', async () => {
    install();
    await checkout();
    const asked = secrets.getSecret.mock.calls.map(([name]) => name);
    expect(asked).toEqual(expect.arrayContaining(['SENDGRID_API_KEY', 'FROM_EMAIL', 'OPS_EMAIL']));
  });

  test.each(['SENDGRID_API_KEY', 'FROM_EMAIL', 'OPS_EMAIL'])(
    'a missing %s stops the send and warns, without failing the save',
    async (missing) => {
      install();
      delete secretValues[missing];

      const res = await checkout();
      expect(res.success).toBe(true);
      expect(res.warning).toContain('Missing SendGrid secrets');
      expect(mockSendgrid.sent).toHaveLength(0);
      expect(rentalRow().rentalState).toBe('Active Rental');
    },
  );

  test('a vault that is unreachable warns rather than throwing', async () => {
    install();
    secrets.getSecret = jest.fn(async () => { throw new Error('secrets vault unavailable'); });

    const res = await checkout();
    expect(res.success).toBe(true);
    expect(res.warning).toContain('secrets vault unavailable');
    expect(mockSendgrid.sent).toHaveLength(0);
  });

  test('the document is still rendered before the secrets are read', async () => {
    // Worth knowing: a misconfigured vault costs a wasted render every
    // check-out, because the send is only prepared for after the attachment
    // exists.
    install();
    delete secretValues.OPS_EMAIL;
    await checkout();
    expect(mockPdfkit.docs).toHaveLength(1);
  });
});

describe('when the send itself fails', () => {
  test('the warning names the reason and the save stands', async () => {
    install();
    mockSendgrid.sendError = 'Rejected: 401 Unauthorized';

    const res = await checkout();
    expect(res.success).toBe(true);
    expect(res.warning).toContain('Rejected: 401 Unauthorized');
    expect(res.rentalState).toBe('Active Rental');
  });

  test('the response still carries the totals the screen re-renders from', async () => {
    install();
    mockSendgrid.sendError = 'Rejected';
    const res = await checkout({ charges: { rental: 135, insurance: 36 } });
    expect(res.totals.gross).toBe(171);
  });

  test('the diagnostics survive the failure, so the render is still explained', async () => {
    install();
    mockSendgrid.sendError = 'Rejected';
    const res = await checkout({ documentRenderMode: 'pdf_from_html' });
    expect(res.renderDiagnostics).toMatchObject({ mode: 'pdf_from_html', engine: 'puppeteer_html_pdf' });
  });
});
