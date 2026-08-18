import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { loginStaff, derivePasswordHash, randomHex } from '../staffAccess.jsw';
import { searchContractCustomers, searchContractCompanies } from '../rentalContract.jsw';

// The two directory pickers behind the contract screen: type a few letters into
// the customer or company box and these answer with rows to fill the form from.
// Neither had a test.
//
// They are the only exports in this module gated at View rather than Edit, and
// the customer half hands back identity-document and licence numbers, so what
// they return and to whom is worth stating rather than inferring.

const ADMIN = 'admin@example.com';
const VIEWER = 'viewer@example.com';
const PASSWORD = 'correct-horse-battery';

const CUSTOMERS = [
  {
    _id: 'cus-2', isActive: true,
    customerCode: 'C-0002', fullName: 'Beta Vasiliou',
    email: 'beta@example.com', mobilePhone: '6941111111', phone: '2101111111',
    secondaryPhone: '6949999999', address: 'Ermou 5', city: 'Athens',
    // Both documents on file, so the precedence between them is observable.
    idNumber: 'AB123456', passportNumber: 'P-00001', country: 'GR',
    licenseNumber: 'L-777', licenseCountry: 'GR',
    licenseIssueDate: '2019-06-01',
    // Stored as a timestamp rather than a plain date, so the formatting is
    // observable: with the raw value echoed back this would keep its time.
    licenseExpiry: '2029-06-01T22:15:00.000Z',
    idIssueDate: '2018-02-11', idExpiry: '2028-02-11',
    dateOfBirth: '1988-04-02', notes: 'Repeat customer',
    searchBlob: 'beta vasiliou 6941111111 ab123456',
  },
  {
    _id: 'cus-1', isActive: true,
    customerCode: 'C-0001', fullName: 'Alpha Papadopoulos',
    email: 'alpha@example.com', phone: '2102222222',
    city: 'Patras', passportNumber: 'P-55512', nationality: 'CY',
    searchBlob: 'alpha papadopoulos 2102222222',
  },
  {
    _id: 'cus-3', isActive: false,
    customerCode: 'C-0003', fullName: 'Gamma Retired',
    searchBlob: 'gamma retired',
  },
  {
    // No fullName and no title — the name is assembled from the parts.
    _id: 'cus-4', isActive: true,
    firstName: 'Delta', lastName: 'Nikolaou',
    searchBlob: 'delta nikolaou',
  },
];

const COMPANIES = [
  {
    _id: 'co-2', isActive: true,
    companyName: 'Beta Logistics AE', tradeName: 'BetaLog',
    vatNumber: '999888777', taxOffice: 'FAE Athinon',
    phone: '2103333333', email: 'accounts@betalog.example',
    address: 'Syngrou 100', city: 'Athens', zipCode: '11745', country: 'GR',
    contactPerson: 'M. Ioannou', poNumberDefault: 'PO-2026',
    notes: 'Monthly invoice', searchBlob: 'beta logistics betalog 999888777',
  },
  {
    _id: 'co-1', isActive: true,
    companyName: 'Alpha Travel EPE', vatNumber: '111222333',
    searchBlob: 'alpha travel 111222333',
  },
  {
    _id: 'co-3', isActive: false,
    companyName: 'Gamma Dormant', searchBlob: 'gamma dormant',
  },
  {
    // No companyName — falls back to title.
    _id: 'co-4', isActive: true,
    title: 'Delta Holdings', searchBlob: 'delta holdings',
  },
];

function seed(extra = {}) {
  const passwordSalt = randomHex(16);
  const cred = (email) => ({
    _id: `cred-${email}`, email, passwordSalt,
    passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true,
  });
  return {
    StaffRoles: [
      { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true },
      // May look at rentals, may not change them. Enough to reach both pickers.
      { _id: 'role-viewer', key: 'viewer', label: 'Viewer', active: true, rentalsView: true, specialPermissions: '' },
    ],
    StaffUsers: [
      { _id: 'u-admin', email: ADMIN, fullName: 'Admin', roleKey: 'admin', active: true },
      { _id: 'u-viewer', email: VIEWER, fullName: 'Viewer', roleKey: 'viewer', active: true },
    ],
    StaffCredentials: [cred(ADMIN), cred(VIEWER)],
    StaffSessions: [],
    StaffAuditLog: [],
    Customers: CUSTOMERS,
    Companies: COMPANIES,
    ...extra,
  };
}

let fake;
let querySpy = null;
function install(extra) {
  fake = createFakeWixData(seed(extra)).install(wixData);
  return fake;
}
async function token(email = ADMIN) {
  const { sessionToken } = await loginStaff({ email, password: PASSWORD });
  return sessionToken;
}

/**
 * Records the query builder calls the module makes. The fake's `contains` is
 * case-insensitive, so a behavioural test cannot tell whether the module folded
 * the query's case or the fake did — and the case fold is the whole reason a
 * capitalised name typed at the desk matches a lower-cased blob. Watching the
 * argument is the only way to pin it.
 */
function spyOnQueries() {
  const seen = [];
  const original = wixData.query;
  wixData.query = (collection) => {
    const inner = original(collection);
    const proxy = new Proxy(inner, {
      get(target, prop) {
        const value = target[prop];
        if (typeof value !== 'function') return value;
        return (...args) => {
          if (prop !== 'find') seen.push({ collection, method: String(prop), args });
          const result = value.apply(target, args);
          return result === inner ? proxy : result;
        };
      },
    });
    return proxy;
  };
  querySpy = { seen, restore: () => { wixData.query = original; } };
  return querySpy;
}

/**
 * Makes one collection unavailable, leaving the rest working. Breaking
 * wixData.query outright breaks the session lookup too, so the call fails at the
 * auth gate and the handler's own error path never runs.
 */
function breakCollection(name, message) {
  const original = wixData.query;
  wixData.query = (collection) => {
    if (collection === name) throw new Error(message);
    return original(collection);
  };
  querySpy = { seen: [], restore: () => { wixData.query = original; } };
}

const names = (res) => res.items.map((i) => i.name);
const companyNames = (res) => res.items.map((i) => i.companyName);

afterEach(() => {
  if (querySpy) { querySpy.restore(); querySpy = null; }
  if (fake) fake.restore();
  fake = null;
});

describe('who may search', () => {
  test('an unauthenticated caller is refused, for both pickers', async () => {
    install();
    await expect(searchContractCustomers({ query: 'alpha' })).rejects.toThrow('AUTH_REQUIRED');
    await expect(searchContractCompanies({ query: 'alpha' })).rejects.toThrow('AUTH_REQUIRED');
  });

  test('a caller who may only view rentals can read the whole customer directory', async () => {
    // Both pickers are gated at View, not Edit, and an empty query is a browse
    // rather than an error — so a role that can only look at rentals can pull
    // back customer rows complete with identity and licence numbers. Stated
    // here as behaviour, not endorsed: if that is not wanted, this test is the
    // one that should change.
    install();
    const res = await searchContractCustomers({ authToken: await token(VIEWER), query: '' });

    expect(res.success).toBe(true);
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.find((i) => i.name === 'Beta Vasiliou')).toMatchObject({
      idNo: 'AB123456', licenseNo: 'L-777', dob: '1988-04-02',
    });
  });

  test('and the company directory too', async () => {
    install();
    const res = await searchContractCompanies({ authToken: await token(VIEWER), query: '' });
    expect(res.success).toBe(true);
    expect(companyNames(res)).toContain('Beta Logistics AE');
  });

  test('a role with no rentals access at all is refused', async () => {
    const s = seed();
    s.StaffRoles.push({ _id: 'role-none', key: 'none', label: 'No access', active: true, specialPermissions: '' });
    s.StaffUsers.push({ _id: 'u-none', email: 'none@example.com', fullName: 'None', roleKey: 'none', active: true });
    const passwordSalt = randomHex(16);
    s.StaffCredentials.push({
      _id: 'cred-none', email: 'none@example.com', passwordSalt,
      passwordHash: derivePasswordHash(PASSWORD, passwordSalt), active: true,
    });
    fake = createFakeWixData(s).install(wixData);

    await expect(searchContractCustomers({ authToken: await token('none@example.com'), query: '' }))
      .rejects.toThrow('ACCESS_DENIED');
  });
});

describe('searching customers', () => {
  test('an empty query browses the directory, sorted by name', async () => {
    install();
    const res = await searchContractCustomers({ authToken: await token(), query: '' });
    expect(names(res)).toEqual(['Delta Nikolaou', 'Alpha Papadopoulos', 'Beta Vasiliou']);
  });

  test('the sort is on the stored fullName, not on the name that comes back', async () => {
    // Delta Nikolaou has no fullName — the name is assembled from firstName and
    // lastName on the way out, after the sort has already happened. So a
    // customer stored that way sorts as if they had no name at all and lands at
    // the top of the list rather than under D. Alphabetical among the rest.
    install();
    const res = await searchContractCustomers({ authToken: await token(), query: '' });
    expect(res.items[0].name).toBe('Delta Nikolaou');
    expect(names(res).slice(1)).toEqual(['Alpha Papadopoulos', 'Beta Vasiliou']);
  });

  test('a whitespace-only query is treated as empty, not as a search for a space', async () => {
    install();
    const res = await searchContractCustomers({ authToken: await token(), query: '   ' });
    expect(names(res)).toHaveLength(3);
  });

  test('a query filters on the search blob', async () => {
    install();
    const res = await searchContractCustomers({ authToken: await token(), query: 'papadopoulos' });
    expect(names(res)).toEqual(['Alpha Papadopoulos']);
  });

  test('the blob carries more than the name, so a phone number finds the row', async () => {
    install();
    const res = await searchContractCustomers({ authToken: await token(), query: '6941111111' });
    expect(names(res)).toEqual(['Beta Vasiliou']);
  });

  test('a query is trimmed and lower-cased before it reaches the collection', async () => {
    install();
    const spy = spyOnQueries();
    await searchContractCustomers({ authToken: await token(), query: '  PAPADOpoulos  ' });

    const call = spy.seen.find((c) => c.collection === 'Customers' && c.method === 'contains');
    expect(call).toBeDefined();
    expect(call.args).toEqual(['searchBlob', 'papadopoulos']);
  });

  test('a search is not sorted, unlike a browse', async () => {
    // The empty-query branch calls ascending('fullName'); the search branch does
    // not, so results come back in whatever order the collection gives them.
    install();
    const spy = spyOnQueries();
    await searchContractCustomers({ authToken: await token(), query: 'a' });
    expect(spy.seen.some((c) => c.method === 'ascending')).toBe(false);

    const res = await searchContractCustomers({ authToken: await token(), query: 'a' });
    expect(names(res)).toEqual(['Beta Vasiliou', 'Alpha Papadopoulos', 'Delta Nikolaou']);
  });

  test('inactive customers are left out of a browse', async () => {
    install();
    const res = await searchContractCustomers({ authToken: await token(), query: '' });
    expect(names(res)).not.toContain('Gamma Retired');
  });

  test('and out of a search that would otherwise match them', async () => {
    install();
    const res = await searchContractCustomers({ authToken: await token(), query: 'gamma' });
    expect(res.items).toEqual([]);
  });

  test('a query matching nothing succeeds with no rows', async () => {
    install();
    const res = await searchContractCustomers({ authToken: await token(), query: 'nobody here' });
    expect(res).toEqual({ success: true, items: [] });
  });
});

describe('what a customer row carries', () => {
  const find = async (query, name) => {
    const res = await searchContractCustomers({ authToken: await token(), query });
    return res.items.find((i) => i.name === name);
  };

  test('the identifying fields the form fills from', async () => {
    install();
    expect(await find('vasiliou', 'Beta Vasiliou')).toMatchObject({
      customerId: 'cus-2',
      customerCode: 'C-0002',
      name: 'Beta Vasiliou',
      email: 'beta@example.com',
      address: 'Ermou 5',
      notes: 'Repeat customer',
    });
  });

  test('the name is assembled from first and last when there is no full name', async () => {
    install();
    const res = await searchContractCustomers({ authToken: await token(), query: 'nikolaou' });
    expect(names(res)).toEqual(['Delta Nikolaou']);
  });

  test('phone prefers the mobile, and falls back to the landline', async () => {
    install();
    expect((await find('vasiliou', 'Beta Vasiliou')).phone).toBe('6941111111');
    expect((await find('papadopoulos', 'Alpha Papadopoulos')).phone).toBe('2102222222');
  });

  test('the field called `mobile` is actually the secondary phone', async () => {
    // Not the mobile number — mobilePhone is what feeds `phone` above. Pinned
    // because the names invite exactly the wrong mapping on the form side.
    install();
    expect(await find('vasiliou', 'Beta Vasiliou')).toMatchObject({
      phone: '6941111111', mobile: '6949999999',
    });
  });

  test('the id number falls back to the passport number', async () => {
    install();
    // Beta has both on file — the id number wins. Alpha has only a passport.
    expect((await find('vasiliou', 'Beta Vasiliou')).idNo).toBe('AB123456');
    expect((await find('papadopoulos', 'Alpha Papadopoulos')).idNo).toBe('P-55512');
  });

  test('the id country falls back to the nationality', async () => {
    install();
    expect((await find('vasiliou', 'Beta Vasiliou')).idCountry).toBe('GR');
    expect((await find('papadopoulos', 'Alpha Papadopoulos')).idCountry).toBe('CY');
  });

  test('the city is returned twice, as both residence and origin', async () => {
    // Two form fields, one stored value — filling one from a search always fills
    // the other, whatever the customer's origin actually was.
    install();
    expect(await find('papadopoulos', 'Alpha Papadopoulos')).toMatchObject({
      residenceCity: 'Patras', originCity: 'Patras',
    });
  });

  test('dates come back as date-input values', async () => {
    install();
    expect(await find('vasiliou', 'Beta Vasiliou')).toMatchObject({
      licenseIssueDate: '2019-06-01',
      // Stored with a time on it; the form wants a date, so the time is dropped.
      licenseExpiry: '2029-06-01',
      idIssueDate: '2018-02-11',
      idExpiry: '2028-02-11',
      dob: '1988-04-02',
    });
  });

  test('a value already shaped like a date is passed through unparsed', async () => {
    // toDateInputValue short-circuits on /^\d{4}-\d{2}-\d{2}$/ rather than
    // parsing and reformatting. That matters because the reformat reads the
    // parsed instant back through the server's local clock: 2019-06-01 parses
    // as midnight UTC, which in any zone behind UTC reads back as 31 May.
    //
    // The suite runs in UTC, where that shift is invisible, so an impossible
    // date is used as the discriminator instead — it matches the pattern and
    // comes back verbatim, where parsing it would yield "". The pattern is a
    // shape check, not a validation.
    install({ Customers: [{ _id: 'c', isActive: true, fullName: 'T', searchBlob: 't', licenseExpiry: '2029-13-45' }] });
    const res = await searchContractCustomers({ authToken: await token(), query: 't' });
    expect(res.items[0].licenseExpiry).toBe('2029-13-45');
  });

  test('a stored timestamp is reduced to its date', async () => {
    install({ Customers: [{ _id: 'c', isActive: true, fullName: 'T', searchBlob: 't', dateOfBirth: new Date('1990-07-15T12:30:00.000Z') }] });
    const res = await searchContractCustomers({ authToken: await token(), query: 't' });
    expect(res.items[0].dob).toBe('1990-07-15');
  });

  test('a missing date is an empty string, not the epoch', async () => {
    install();
    expect(await find('papadopoulos', 'Alpha Papadopoulos')).toMatchObject({
      licenseExpiry: '', dob: '', idExpiry: '',
    });
  });

  test('an unparseable date is an empty string too', async () => {
    install({ Customers: [{ _id: 'c', isActive: true, fullName: 'T', searchBlob: 't', dateOfBirth: 'sometime in the 90s' }] });
    const res = await searchContractCustomers({ authToken: await token(), query: 't' });
    expect(res.items[0].dob).toBe('');
  });

  test('every field is a string, so a missing one is blank rather than undefined', async () => {
    install();
    const row = await find('nikolaou', 'Delta Nikolaou');
    for (const [key, value] of Object.entries(row)) {
      expect(typeof value).toBe('string');
      if (key !== 'customerId' && key !== 'name' && key !== 'searchBlob') expect(value).toBe('');
    }
  });

  test('the blob is echoed back lower-cased for the picker to filter on', async () => {
    install({ Customers: [{ _id: 'c', isActive: true, fullName: 'T', searchBlob: 'Mixed Case BLOB' }] });
    const res = await searchContractCustomers({ authToken: await token(), query: '' });
    expect(res.items[0].searchBlob).toBe('mixed case blob');
  });
});

describe('searching companies', () => {
  test('an empty query browses, sorted by company name', async () => {
    // Same asymmetry as the customer picker: Delta Holdings is stored under
    // `title` with no companyName, so it sorts as nameless and comes first even
    // though it comes back named.
    install();
    const res = await searchContractCompanies({ authToken: await token(), query: '' });
    expect(companyNames(res)).toEqual(['Delta Holdings', 'Alpha Travel EPE', 'Beta Logistics AE']);
  });

  test('a query filters on the search blob', async () => {
    install();
    const res = await searchContractCompanies({ authToken: await token(), query: 'betalog' });
    expect(companyNames(res)).toEqual(['Beta Logistics AE']);
  });

  test('a VAT number finds the company', async () => {
    install();
    const res = await searchContractCompanies({ authToken: await token(), query: '111222333' });
    expect(companyNames(res)).toEqual(['Alpha Travel EPE']);
  });

  test('the query is trimmed and lower-cased here too', async () => {
    install();
    const spy = spyOnQueries();
    await searchContractCompanies({ authToken: await token(), query: '  BetaLog ' });
    const call = spy.seen.find((c) => c.collection === 'Companies' && c.method === 'contains');
    expect(call.args).toEqual(['searchBlob', 'betalog']);
  });

  test('inactive companies are left out', async () => {
    install();
    const browse = await searchContractCompanies({ authToken: await token(), query: '' });
    expect(companyNames(browse)).not.toContain('Gamma Dormant');
    const search = await searchContractCompanies({ authToken: await token(), query: 'gamma' });
    expect(search.items).toEqual([]);
  });

  test('the company name falls back to the record title', async () => {
    install();
    const res = await searchContractCompanies({ authToken: await token(), query: 'delta' });
    expect(companyNames(res)).toEqual(['Delta Holdings']);
  });

  test('the billing fields the invoice block fills from', async () => {
    install();
    const res = await searchContractCompanies({ authToken: await token(), query: 'betalog' });
    expect(res.items[0]).toMatchObject({
      companyId: 'co-2',
      companyName: 'Beta Logistics AE',
      tradeName: 'BetaLog',
      vatNumber: '999888777',
      taxOffice: 'FAE Athinon',
      phone: '2103333333',
      email: 'accounts@betalog.example',
      address: 'Syngrou 100',
      city: 'Athens',
      country: 'GR',
      contactPerson: 'M. Ioannou',
      poNumberDefault: 'PO-2026',
      notes: 'Monthly invoice',
    });
  });

  test('the postcode is read from zipCode and returned as zip', async () => {
    install();
    const res = await searchContractCompanies({ authToken: await token(), query: 'betalog' });
    expect(res.items[0].zip).toBe('11745');
  });

  test('a company row carries no licence or identity fields', async () => {
    // The two pickers fill different halves of the contract; nothing in the
    // company row should be feeding driver identity.
    install();
    const res = await searchContractCompanies({ authToken: await token(), query: 'betalog' });
    expect(Object.keys(res.items[0]).sort()).toEqual([
      'address', 'city', 'companyId', 'companyName', 'contactPerson', 'country',
      'email', 'notes', 'phone', 'poNumberDefault', 'searchBlob', 'taxOffice',
      'tradeName', 'vatNumber', 'zip',
    ]);
  });
});

describe('the row limit', () => {
  const many = (n, prefix) => Array.from({ length: n }, (_, i) => ({
    _id: `${prefix}-${i}`, isActive: true,
    fullName: `Person ${String(i).padStart(3, '0')}`,
    companyName: `Company ${String(i).padStart(3, '0')}`,
    searchBlob: `person ${i}`,
  }));

  test('defaults to 50', async () => {
    install({ Customers: many(300, 'c') });
    const res = await searchContractCustomers({ authToken: await token(), query: '' });
    expect(res.items).toHaveLength(50);
  });

  test('is honoured when asked for fewer', async () => {
    install({ Customers: many(300, 'c') });
    const res = await searchContractCustomers({ authToken: await token(), query: '', limit: 5 });
    expect(res.items).toHaveLength(5);
  });

  test('is capped at 200 however large the request', async () => {
    install({ Customers: many(300, 'c') });
    const res = await searchContractCustomers({ authToken: await token(), query: '', limit: 100000 });
    expect(res.items).toHaveLength(200);
  });

  test('a zero limit falls back to the default rather than returning nothing', async () => {
    // `Number(limit) || 50` — 0 is falsy, so it becomes 50, not 0.
    install({ Customers: many(300, 'c') });
    const res = await searchContractCustomers({ authToken: await token(), query: '', limit: 0 });
    expect(res.items).toHaveLength(50);
  });

  test('a negative limit is raised to one row', async () => {
    install({ Customers: many(300, 'c') });
    const res = await searchContractCustomers({ authToken: await token(), query: '', limit: -20 });
    expect(res.items).toHaveLength(1);
  });

  test('a non-numeric limit falls back to the default', async () => {
    install({ Customers: many(300, 'c') });
    const res = await searchContractCustomers({ authToken: await token(), query: '', limit: 'lots' });
    expect(res.items).toHaveLength(50);
  });

  test('applies to a search as well as a browse', async () => {
    install({ Customers: many(300, 'c') });
    const res = await searchContractCustomers({ authToken: await token(), query: 'person', limit: 7 });
    expect(res.items).toHaveLength(7);
  });

  test('and to companies, with the same cap', async () => {
    install({ Companies: many(300, 'co') });
    const res = await searchContractCompanies({ authToken: await token(), query: '', limit: 100000 });
    expect(res.items).toHaveLength(200);
  });

  test('there is no way to page past the cap', async () => {
    // No skip/offset parameter, so 200 is the most a single caller can pull in
    // one request — worth knowing alongside the View-only gate above.
    install({ Customers: many(300, 'c') });
    const spy = spyOnQueries();
    await searchContractCustomers({ authToken: await token(), query: '', limit: 100000 });
    expect(spy.seen.some((c) => c.method === 'skip')).toBe(false);
    const call = spy.seen.find((c) => c.collection === 'Customers' && c.method === 'limit');
    expect(call.args).toEqual([200]);
  });
});

describe('when the collection is unavailable', () => {
  test('a customer search reports the failure instead of throwing', async () => {
    install();
    const t = await token();
    breakCollection('Customers', 'Customers is offline');

    await expect(searchContractCustomers({ authToken: t, query: 'alpha' }))
      .resolves.toEqual({ success: false, message: 'Customers is offline', items: [] });
  });

  test('a browse reports it the same way as a search', async () => {
    install();
    const t = await token();
    breakCollection('Customers', 'Customers is offline');

    await expect(searchContractCustomers({ authToken: t, query: '' }))
      .resolves.toEqual({ success: false, message: 'Customers is offline', items: [] });
  });

  test('a company search does the same', async () => {
    install();
    const t = await token();
    breakCollection('Companies', 'Companies is offline');

    await expect(searchContractCompanies({ authToken: t, query: '' }))
      .resolves.toEqual({ success: false, message: 'Companies is offline', items: [] });
  });

  test('the failure is reported after the auth gate, not instead of it', async () => {
    // The try block starts below requireStaffAccess, so a broken collection
    // cannot turn an unauthenticated call into a polite { success: false }. The
    // break is scoped to Customers so the session lookup still works and the
    // gate is genuinely what rejects.
    install();
    breakCollection('Customers', 'Customers is offline');
    await expect(searchContractCustomers({ query: 'alpha' })).rejects.toThrow('AUTH_REQUIRED');
  });
});
