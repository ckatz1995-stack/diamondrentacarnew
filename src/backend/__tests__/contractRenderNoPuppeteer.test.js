import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import * as contract from '../rentalContract.jsw';

// The same document endpoints as contractDocumentRender.test.js, but in a
// runtime where puppeteer is not installed at all — `require` throws rather than
// the browser failing.
//
// This is the case the capability snapshot's `runtimeLimitations` note was
// written for, and it is a different code path from a browser that crashes: the
// snapshot reports the engine as unavailable up front instead of discovering it
// mid-render. It needs its own file because jest.mock is hoisted to the top of
// the module, so a single file cannot have puppeteer both present and absent.
//
// pdfkit is still supplied, since in this runtime the text renderer is the only
// engine there is and everything depends on it working.

jest.mock('puppeteer', () => {
  const error = new Error("Cannot find module 'puppeteer'");
  // @ts-ignore -- matching Node's shape so a `catch` that inspects it behaves.
  error.code = 'MODULE_NOT_FOUND';
  throw error;
}, { virtual: true });

jest.mock('pdfkit', () => {
  const { EventEmitter } = require('events');
  return class FakePDFDocument extends EventEmitter {
    constructor(options) { super(); this.options = options; this.lines = []; }
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

const STAFF = 'staff@example.com';
const PASSWORD = 'correct-horse-battery';
const BOOKING_ID = 'bk-1';

function seed() {
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
      email: 'customer@example.com',
      pickupDateTime: '2026-03-10T08:00:00.000Z',
      dropoffDateTime: '2026-03-13T08:00:00.000Z',
      categoryId: 'ECO',
      baseCost: 135, insuranceCost: 36, extrasTotal: 0, ageFee: 0, nightFee: 0, totalPrice: 171,
    }],
    RentalsNew: [],
    FleetNew: [],
    VehiclesNew: [],
  };
}

let fake;
function install() {
  fake = createFakeWixData(seed()).install(wixData);
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

describe('the capability snapshot without puppeteer', () => {
  test('reports the high-fidelity engine as unavailable', async () => {
    install();
    const res = await contract.getContractDocumentRenderCapabilities({ authToken: await token() });

    expect(res.success).toBe(true);
    expect(res.capabilities.supportsPdfFromHtmlHifi).toBe(false);
  });

  test('still offers the template and the text renderer', async () => {
    // A missing browser is not a missing document pipeline — the whole point of
    // the ladder is that contracts keep coming out.
    install();
    const res = await contract.getContractDocumentRenderCapabilities({ authToken: await token() });
    expect(res.capabilities.supportsHtmlTemplate).toBe(true);
    expect(res.capabilities.supportsPdfFromHtml).toBe(true);
  });

  test('prefers the text renderer, and lists only that engine', async () => {
    install();
    const res = await contract.getContractDocumentRenderCapabilities({ authToken: await token() });
    expect(res.capabilities.preferredRenderEngine).toBe('pdfkit_text_fallback');
    expect(res.capabilities.availableRenderEngines).toEqual(['pdfkit_text_fallback']);
  });

  test('says why, rather than reporting an unexplained downgrade', async () => {
    install();
    const res = await contract.getContractDocumentRenderCapabilities({ authToken: await token() });
    expect(res.capabilities.runtimeLimitations).toHaveLength(1);
    expect(res.capabilities.runtimeLimitations[0]).toContain('Puppeteer module unavailable');
  });
});

describe('rendering a PDF without puppeteer', () => {
  test('still produces one, through the text renderer', async () => {
    install();
    const res = await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });

    expect(res.success).toBe(true);
    expect(res.renderEngine).toBe('pdfkit_text_fallback');
    expect(res.fidelity).toBe('baseline');
    expect(Buffer.from(res.pdfBase64, 'base64').toString()).toContain('PDFKIT:');
  });

  test('the fallback is recorded as used, and the reason names the module', async () => {
    install();
    const res = await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });

    expect(res.fallbackUsed).toBe(true);
    expect(res.fallbackReason).toContain('HIGH_FIDELITY_ERROR');
    expect(res.fallbackReason).toContain('puppeteer');
  });

  test('the browser engine is still attempted, so the record is honest', async () => {
    // The ladder does not consult the snapshot before trying — it tries and
    // records the failure. Worth pinning: the attempt list is what an operator
    // reads to tell "never tried" from "tried and failed".
    install();
    const res = await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });
    expect(res.attemptedEngines).toEqual(['puppeteer_html_pdf', 'pdfkit_text_fallback']);
  });

  test('the capability warning is carried on the render result', async () => {
    install();
    const res = await contract.exportContractPdfFromHtml({ authToken: await token(), bookingId: BOOKING_ID });
    expect(res.renderWarnings.join(' ')).toContain('Puppeteer module unavailable');
  });
});

describe('the self-test without puppeteer', () => {
  test('reports fallback-only, blaming the missing module rather than a render', async () => {
    install();
    const res = await contract.selfTestContractDocumentRenderer({ authToken: await token() });

    expect(res.selfTest.status).toBe('fallback-only');
    expect(res.selfTest.failureStage).toBe('HIFI_MODULE');
    expect(res.selfTest.stages.hifi.modulePresent).toBe(false);
  });

  test('the text renderer is still verified as working', async () => {
    install();
    const res = await contract.selfTestContractDocumentRenderer({ authToken: await token() });
    expect(res.selfTest.stages.fallback.renderSupported).toBe(true);
    expect(res.selfTest.fallbackRequired).toBe(true);
  });

  test('the warnings carry both the downgrade and its cause', async () => {
    install();
    const res = await contract.selfTestContractDocumentRenderer({ authToken: await token() });
    const warnings = res.selfTest.warnings.join(' ');
    expect(warnings).toContain('fallback-only mode');
    expect(warnings).toContain('Puppeteer module unavailable');
  });
});

describe('the template regression without puppeteer', () => {
  test('still passes, because the text renderer carries it', async () => {
    install();
    const res = await contract.runContractDocumentTemplateRegression({ authToken: await token() });

    expect(res.report.success).toBe(true);
    expect(res.report.failedDocuments).toEqual([]);
    for (const result of res.report.results) {
      expect(result.pdfSmoke).toMatchObject({ ok: true, engine: 'pdfkit_text_fallback', fidelity: 'baseline' });
    }
  });
});
