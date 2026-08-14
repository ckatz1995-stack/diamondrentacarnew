// A small in-memory stand-in for wix-data, enough to exercise backend modules
// that query and write collections. Supports the subset of the query builder the
// backend actually uses: eq / ne / ascending / limit / find, plus insert, update,
// remove and get.
//
// Usage:
//   const fake = createFakeWixData({ StaffUsers: [{ _id: 'u1', email: 'a@b.c' }] });
//   fake.install(wixData);   // swap the methods onto the imported module object
//   ...
//   fake.restore();          // put the originals back

let idCounter = 0;
function nextId(prefix = 'id') {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function valuesMatch(rowValue, expected) {
  if (rowValue instanceof Date && expected instanceof Date) return rowValue.getTime() === expected.getTime();
  // wix-data compares loosely across the string/number boundary for ids and keys.
  if (rowValue === expected) return true;
  if (rowValue == null || expected == null) return false;
  return String(rowValue) === String(expected);
}

export function createFakeWixData(seed = {}) {
  const store = new Map();
  for (const [collection, rows] of Object.entries(seed)) {
    store.set(collection, rows.map((row) => ({ ...row })));
  }

  const rowsFor = (collection) => {
    if (!store.has(collection)) store.set(collection, []);
    return store.get(collection);
  };

  const calls = { insert: [], update: [], remove: [] };

  function query(collection) {
    const filters = [];
    const sorts = [];
    let limitValue = 1000;

    const builder = {
      eq(field, value) { filters.push((row) => valuesMatch(row?.[field], value)); return builder; },
      ne(field, value) { filters.push((row) => !valuesMatch(row?.[field], value)); return builder; },
      lt(field, value) { filters.push((row) => new Date(row?.[field]) < new Date(value)); return builder; },
      gt(field, value) { filters.push((row) => new Date(row?.[field]) > new Date(value)); return builder; },
      ascending(field) { sorts.push(field); return builder; },
      descending(field) { sorts.push(`-${field}`); return builder; },
      include() { return builder; },
      limit(n) { limitValue = n; return builder; },
      async find() {
        let items = rowsFor(collection).filter((row) => filters.every((f) => f(row)));
        for (const sort of [...sorts].reverse()) {
          const desc = sort.startsWith('-');
          const field = desc ? sort.slice(1) : sort;
          items = [...items].sort((a, b) => {
            const av = a?.[field];
            const bv = b?.[field];
            if (av === bv) return 0;
            const cmp = av > bv ? 1 : -1;
            return desc ? -cmp : cmp;
          });
        }
        return { items: items.slice(0, limitValue).map((row) => ({ ...row })), totalCount: items.length };
      },
    };
    return builder;
  }

  async function insert(collection, item) {
    const row = { ...item, _id: item?._id || nextId(collection.toLowerCase()) };
    rowsFor(collection).push(row);
    calls.insert.push({ collection, item: row });
    return { ...row };
  }

  async function update(collection, item) {
    const rows = rowsFor(collection);
    const index = rows.findIndex((row) => valuesMatch(row._id, item?._id));
    if (index === -1) throw new Error(`fakeWixData: no ${collection} row with _id ${item?._id}`);
    rows[index] = { ...item };
    calls.update.push({ collection, item: { ...item } });
    return { ...rows[index] };
  }

  async function remove(collection, id) {
    const rows = rowsFor(collection);
    const index = rows.findIndex((row) => valuesMatch(row._id, id));
    const [removed] = index === -1 ? [null] : rows.splice(index, 1);
    calls.remove.push({ collection, id });
    return removed ? { ...removed } : null;
  }

  async function get(collection, id) {
    const row = rowsFor(collection).find((r) => valuesMatch(r._id, id));
    return row ? { ...row } : null;
  }

  const api = { query, insert, update, remove, get };
  let target = null;
  let originals = null;

  return {
    ...api,
    calls,
    /** Rows currently held for a collection (copies). */
    rows: (collection) => rowsFor(collection).map((row) => ({ ...row })),
    /** Swap the fake's methods onto an imported wix-data module object. */
    install(wixDataModule) {
      target = wixDataModule;
      originals = { ...wixDataModule };
      Object.assign(target, api);
      return this;
    },
    restore() {
      if (target && originals) Object.assign(target, originals);
      target = null;
      originals = null;
    },
  };
}
