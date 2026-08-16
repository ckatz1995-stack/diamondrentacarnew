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

// `strictCollections` makes an unseeded collection throw instead of springing
// into existence empty. Real wix-data rejects a query against a collection that
// does not exist, and some backend modules rely on exactly that: they try a list
// of candidate collection names and let the failures fall through to the one
// that is really there. Under the lenient default the first candidate answers
// with an empty result and the real collection is never reached, so those
// fallbacks look tested when nothing exercised them. Off by default because most
// suites just want the collections they seeded.
export function createFakeWixData(seed = {}, { strictCollections = false } = {}) {
  const store = new Map();
  for (const [collection, rows] of Object.entries(seed)) {
    store.set(collection, rows.map((row) => ({ ...row })));
  }

  const rowsFor = (collection) => {
    if (!store.has(collection)) {
      if (strictCollections) throw new Error(`fakeWixData: collection ${collection} does not exist`);
      store.set(collection, []);
    }
    return store.get(collection);
  };

  const calls = { insert: [], update: [], remove: [], bulkRemove: [] };

  function query(collection) {
    const filters = [];
    const sorts = [];
    let limitValue = 1000;

    // Comparisons mirror wix-data: lt/gt/le/ge are used on date fields in this
    // codebase, so they compare as dates; the rest compare as values or strings.
    const asComparable = (v) => (v instanceof Date || typeof v === 'string' ? new Date(v) : v);
    const str = (v) => String(v ?? '');

    const builder = {
      eq(field, value) { filters.push((row) => valuesMatch(row?.[field], value)); return builder; },
      ne(field, value) { filters.push((row) => !valuesMatch(row?.[field], value)); return builder; },
      lt(field, value) { filters.push((row) => asComparable(row?.[field]) < asComparable(value)); return builder; },
      gt(field, value) { filters.push((row) => asComparable(row?.[field]) > asComparable(value)); return builder; },
      le(field, value) { filters.push((row) => asComparable(row?.[field]) <= asComparable(value)); return builder; },
      ge(field, value) { filters.push((row) => asComparable(row?.[field]) >= asComparable(value)); return builder; },
      between(field, a, b) {
        filters.push((row) => asComparable(row?.[field]) >= asComparable(a) && asComparable(row?.[field]) <= asComparable(b));
        return builder;
      },
      startsWith(field, value) { filters.push((row) => str(row?.[field]).startsWith(str(value))); return builder; },
      endsWith(field, value) { filters.push((row) => str(row?.[field]).endsWith(str(value))); return builder; },
      contains(field, value) { filters.push((row) => str(row?.[field]).toLowerCase().includes(str(value).toLowerCase())); return builder; },
      hasSome(field, values) {
        const wanted = (Array.isArray(values) ? values : [values]).map(str);
        filters.push((row) => {
          const actual = Array.isArray(row?.[field]) ? row[field].map(str) : [str(row?.[field])];
          return actual.some((v) => wanted.includes(v));
        });
        return builder;
      },
      hasAll(field, values) {
        const wanted = (Array.isArray(values) ? values : [values]).map(str);
        filters.push((row) => {
          const actual = Array.isArray(row?.[field]) ? row[field].map(str) : [str(row?.[field])];
          return wanted.every((v) => actual.includes(v));
        });
        return builder;
      },
      isEmpty(field) { filters.push((row) => row?.[field] == null || row?.[field] === ''); return builder; },
      isNotEmpty(field) { filters.push((row) => row?.[field] != null && row?.[field] !== ''); return builder; },
      ascending(field) { sorts.push(field); return builder; },
      descending(field) { sorts.push(`-${field}`); return builder; },
      include() { return builder; },
      skip() { return builder; },
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

  // `options` is recorded as well as the payload: wix-data takes suppressAuth as a
  // third argument, and a caller that misplaces it into the item (or drops it) is a
  // real bug this repo has hit more than once. Tests need to assert the call shape.
  async function insert(collection, item, options) {
    const row = { ...item, _id: item?._id || nextId(collection.toLowerCase()) };
    rowsFor(collection).push(row);
    calls.insert.push({ collection, item: row, options });
    return { ...row };
  }

  async function update(collection, item, options) {
    const rows = rowsFor(collection);
    const index = rows.findIndex((row) => valuesMatch(row._id, item?._id));
    if (index === -1) throw new Error(`fakeWixData: no ${collection} row with _id ${item?._id}`);
    rows[index] = { ...item };
    calls.update.push({ collection, item: { ...item }, options });
    return { ...rows[index] };
  }

  async function remove(collection, id, options) {
    const rows = rowsFor(collection);
    const index = rows.findIndex((row) => valuesMatch(row._id, id));
    const [removed] = index === -1 ? [null] : rows.splice(index, 1);
    calls.remove.push({ collection, id, options });
    return removed ? { ...removed } : null;
  }

  async function get(collection, id) {
    const row = rowsFor(collection).find((r) => valuesMatch(r._id, id));
    return row ? { ...row } : null;
  }

  // Returns the same `removed` count shape the session cleanup reads back. Ids
  // that match nothing are skipped rather than counted, so a caller asserting on
  // the count is asserting on rows that actually went.
  async function bulkRemove(collection, ids = [], options) {
    const rows = rowsFor(collection);
    let removed = 0;
    for (const id of ids || []) {
      const index = rows.findIndex((row) => valuesMatch(row._id, id));
      if (index === -1) continue;
      rows.splice(index, 1);
      removed += 1;
    }
    calls.bulkRemove.push({ collection, ids: [...(ids || [])], options });
    return { removed, skipped: (ids || []).length - removed, removedItemIds: [...(ids || [])] };
  }

  const api = { query, insert, update, remove, get, bulkRemove };
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
