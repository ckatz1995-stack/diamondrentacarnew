import wixData from 'wix-data';
import { upsertByKey } from '../pricingAdmin.jsw';

const COLLECTION = 'InsurancePlans';

// Chainable stand-in for a wix-data query builder. The helpers inside
// pricingAdmin.jsw chain .eq()/.limit()/.include() before awaiting .find().
function queryBuilder(items) {
  const builder = {
    eq: () => builder,
    limit: () => builder,
    include: () => builder,
    ascending: () => builder,
    find: async () => ({ items }),
  };
  return builder;
}

function mockCollectionRows(rows) {
  wixData.query = jest.fn(() => queryBuilder(rows));
}

const originalQuery = wixData.query;
const originalUpdate = wixData.update;
const originalInsert = wixData.insert;
const originalRemove = wixData.remove;

beforeEach(() => {
  wixData.update = jest.fn(async (_collection, item) => ({ ...item }));
  wixData.insert = jest.fn(async (_collection, item) => ({ ...item, _id: 'generated-id' }));
  wixData.remove = jest.fn(async () => ({}));
});

afterEach(() => {
  wixData.query = originalQuery;
  wixData.update = originalUpdate;
  wixData.insert = originalInsert;
  wixData.remove = originalRemove;
  jest.restoreAllMocks();
});

describe('upsertByKey — update path', () => {
  const existingRow = {
    _id: 'plan-1',
    key: 'cdw',
    label: 'CDW',
    description: 'Existing description',
    pricePerDay: 0,
    sortOrder: 10,
    publicVisible: true,
  };

  test('passes suppressAuth as the options argument, not as a data field', async () => {
    // Regression test: a misplaced comma operator inside the spread previously
    // made this call `update(collection, { suppressAuth: true, ...item })` with
    // no options argument at all, so updates ran without suppressAuth.
    mockCollectionRows([existingRow]);

    await upsertByKey(COLLECTION, { _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 12 });

    expect(wixData.update).toHaveBeenCalledTimes(1);
    const [collection, item, options] = wixData.update.mock.calls[0];
    expect(collection).toBe(COLLECTION);
    expect(options).toEqual({ suppressAuth: true });
    expect(item).not.toHaveProperty('suppressAuth');
  });

  test('merges the previous record so fields absent from the payload survive', async () => {
    mockCollectionRows([existingRow]);

    await upsertByKey(COLLECTION, { _id: 'plan-1', key: 'cdw', label: 'CDW', pricePerDay: 12 });

    const [, item] = wixData.update.mock.calls[0];
    expect(item.description).toBe('Existing description');
    expect(item.sortOrder).toBe(10);
    expect(item.publicVisible).toBe(true);
  });

  test('lets the incoming payload win over the previous record', async () => {
    mockCollectionRows([existingRow]);

    await upsertByKey(COLLECTION, { _id: 'plan-1', key: 'cdw', label: 'CDW Updated', pricePerDay: 12 });

    const [, item] = wixData.update.mock.calls[0];
    expect(item.pricePerDay).toBe(12);
    expect(item.label).toBe('CDW Updated');
    expect(item._id).toBe('plan-1');
  });

  test('reports update mode and returns the previous record', async () => {
    mockCollectionRows([existingRow]);

    const result = await upsertByKey(COLLECTION, { _id: 'plan-1', key: 'cdw', label: 'CDW' });

    expect(result.mode).toBe('update');
    expect(result.previous).toMatchObject({ _id: 'plan-1' });
    expect(wixData.insert).not.toHaveBeenCalled();
  });

  test('adopts the id of an existing row matched by key when no id is supplied', async () => {
    mockCollectionRows([existingRow]);

    await upsertByKey(COLLECTION, { key: 'cdw', label: 'CDW', pricePerDay: 12 });

    expect(wixData.update).toHaveBeenCalledTimes(1);
    const [, item] = wixData.update.mock.calls[0];
    expect(item._id).toBe('plan-1');
    expect(wixData.insert).not.toHaveBeenCalled();
  });

  test('removes duplicate rows that share the key but not the surviving id', async () => {
    mockCollectionRows([existingRow, { _id: 'plan-duplicate', key: 'cdw', label: 'CDW copy' }]);

    await upsertByKey(COLLECTION, { _id: 'plan-1', key: 'cdw', label: 'CDW' });

    expect(wixData.remove).toHaveBeenCalledTimes(1);
    expect(wixData.remove).toHaveBeenCalledWith(COLLECTION, 'plan-duplicate', { suppressAuth: true });
  });
});

describe('upsertByKey — insert path', () => {
  test('inserts with suppressAuth options when no matching row exists', async () => {
    mockCollectionRows([]);

    const result = await upsertByKey(COLLECTION, { key: 'scdw', label: 'SCDW', pricePerDay: 20 });

    expect(wixData.update).not.toHaveBeenCalled();
    expect(wixData.insert).toHaveBeenCalledTimes(1);
    const [collection, item, options] = wixData.insert.mock.calls[0];
    expect(collection).toBe(COLLECTION);
    expect(options).toEqual({ suppressAuth: true });
    expect(item).not.toHaveProperty('_id');
    expect(item).not.toHaveProperty('suppressAuth');
    expect(result.mode).toBe('insert');
  });

  test('normalizes the key from the label when none is supplied', async () => {
    mockCollectionRows([]);

    await upsertByKey(COLLECTION, { label: 'Full Coverage', pricePerDay: 30 });

    const [, item] = wixData.insert.mock.calls[0];
    expect(item.key).toBe('full_coverage');
  });
});
