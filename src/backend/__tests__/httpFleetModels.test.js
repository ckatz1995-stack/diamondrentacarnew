import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import { get_fleet_models } from '../http-functions.js';

// The public endpoint that decides which cars a customer is shown for a
// category. No session, no token — it answers the open internet, and what it
// returns is what someone picks from and then pays for.
//
// The interesting work is not the query, it is what happens to the rows
// afterwards: they are grouped by a normalised model name, filtered by a
// category that may have been inferred rather than stored, and their photos
// merged. A car leaking in from the wrong category is a customer choosing a
// vehicle they cannot have at a price that is not theirs.

const call = (query = {}) => get_fleet_models({ query, headers: {} });
const body = async (query) => (await call(query)).body;
const models = async (query) => (await body(query)).items.map((i) => i.model);

let fake;
function install(fleet = [], vehicles = []) {
  fake = createFakeWixData({ FleetNew: fleet, VehiclesNew: vehicles }).install(wixData);
  return fake;
}

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

const car = (over = {}) => ({ _id: `f-${Math.random()}`, Model: 'Fiat Panda', Category: 'A', Active: true, ...over });

describe('what comes back', () => {
  test('a successful answer names the category it filtered on', async () => {
    install([car()]);
    expect(await body({ category: 'A' })).toMatchObject({ success: true, category: 'A' });
  });

  test('no category asked for means no category reported', async () => {
    install([car()]);
    expect((await body({})).category).toBe('');
  });

  test('each model carries the fields the booking UI reads', async () => {
    install([car({ Model: 'Fiat Panda', Category: 'A', photos: 'https://img/1.jpg' })]);
    const [item] = (await body({ category: 'A' })).items;
    expect(item).toEqual({ model: 'Fiat Panda', note: '', photos: ['https://img/1.jpg'], category: 'A' });
  });

  test('an empty fleet is an empty list, not a failure', async () => {
    install([]);
    expect(await body({ category: 'A' })).toMatchObject({ success: true, items: [] });
  });

  test('a query that throws is reported as a failure rather than as no cars', async () => {
    // Answering "no vehicles available" when the database is down would quietly
    // close the site instead of showing an error.
    install([car()]);
    wixData.query = () => { throw new Error('collection unavailable'); };
    const response = await call({ category: 'A' });
    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
  });
});

describe('which cars belong to the category asked for', () => {
  test('a car in the category is returned', async () => {
    install([car({ Model: 'Fiat Panda', Category: 'A' })]);
    expect(await models({ category: 'A' })).toEqual(['Fiat Panda']);
  });

  test('a car in another category is not', async () => {
    install([car({ Model: 'Fiat Panda', Category: 'A' }), car({ Model: 'Mercedes CLA', Category: 'LX' })]);
    expect(await models({ category: 'A' })).toEqual(['Fiat Panda']);
  });

  test('the category is matched case-insensitively from the query', async () => {
    install([car({ Model: 'Fiat Panda', Category: 'A' })]);
    expect(await models({ category: 'a' })).toEqual(['Fiat Panda']);
  });

  test('asking for nothing returns every category', async () => {
    install([car({ Model: 'Fiat Panda', Category: 'A' }), car({ Model: 'Mercedes CLA', Category: 'LX' })]);
    expect((await models({})).sort()).toEqual(['Fiat Panda', 'Mercedes CLA']);
  });

  test('a category nothing matches returns nothing rather than everything', async () => {
    install([car({ Model: 'Fiat Panda', Category: 'A' })]);
    expect(await models({ category: 'ZZ' })).toEqual([]);
  });

  test('an inactive car is left out', async () => {
    install([car({ Model: 'Fiat Panda', Active: false }), car({ Model: 'Seat Ibiza', Category: 'A', Active: true })]);
    expect(await models({ category: 'A' })).toEqual(['Seat Ibiza']);
  });

  test('a car with no active flag is treated as active', async () => {
    const { Active: _Active, ...withoutFlag } = car({ Model: 'Fiat Panda' });
    install([withoutFlag]);
    expect(await models({ category: 'A' })).toEqual(['Fiat Panda']);
  });

  test('a row with no model at all is skipped', async () => {
    install([car({ Model: '', Category: 'A' }), car({ Model: 'Fiat Panda', Category: 'A' })]);
    expect(await models({ category: 'A' })).toEqual(['Fiat Panda']);
  });
});

describe('where the category comes from when the row is untidy', () => {
  // Fleet rows have been written by several hands, so the code reads a list of
  // spellings and then falls back to guessing from the model name.
  //
  // UNMAPPED is the important part of the fixture. Every test in this block is
  // about a category being read off the row, so the model must be one the
  // guess-from-the-name map does not know. With a mapped model — Fiat Panda, say
  // — deleting any of these reads still yields category A via the map, and each
  // test passes while covering nothing.
  const UNMAPPED = 'Kia Picanto';
  const untidy = (fields) => {
    const { Category: _C, ...base } = car({ Model: UNMAPPED });
    return [{ ...base, ...fields }];
  };

  test('the fixture model is genuinely not in the guess map', async () => {
    // Guards the assumption the rest of this block rests on.
    install(untidy({}));
    expect(await models({ category: 'A' })).toEqual([]);
  });

  test.each([
    ['Category', { Category: 'A' }],
    ['category', { category: 'A' }],
    ['categoryCode', { categoryCode: 'A' }],
  ])('%s is read', async (_label, fields) => {
    install(untidy(fields));
    expect(await models({ category: 'A' })).toEqual([UNMAPPED]);
  });

  test('a category written as a full label is reduced to its code', async () => {
    install(untidy({ Category: 'A - Mini' }));
    expect(await models({ category: 'A' })).toEqual([UNMAPPED]);
  });

  test('a category held as a reference object is read through it', async () => {
    install(untidy({ Category: { title: 'A - Mini' } }));
    expect(await models({ category: 'A' })).toEqual([UNMAPPED]);
  });

  test('a lower-case category code is not matched as if it were upper-case', async () => {
    // The row's own value is compared verbatim against the upper-cased request.
    install(untidy({ Category: 'a' }));
    expect(await models({ category: 'A' })).toEqual([]);
  });

  test('a known model with no category at all is guessed from its name', async () => {
    // The fallback map exists because rows were imported without categories.
    const { Category: _C, ...base } = car();
    install([{ ...base, Model: 'Mercedes CLA' }]);
    expect(await models({ category: 'LX' })).toEqual(['Mercedes CLA']);
  });

  test('the guess is insensitive to case, spacing and accents', async () => {
    const { Category: _C, ...base } = car();
    install([{ ...base, Model: 'mercedes-cla' }]);
    expect(await models({ category: 'LX' })).toEqual(['mercedes-cla']);
  });

  test('an unknown model with no category is not guessed into one', async () => {
    // Better absent than wrong: inventing a category would put a car in front of
    // a customer at another category's price.
    const { Category: _C, ...base } = car();
    install([{ ...base, Model: 'Bugatti Chiron' }]);
    expect(await models({ category: 'A' })).toEqual([]);
  });

  test('a row nobody can classify does not appear under every category at once', async () => {
    // It used to. The row fell past the mismatch guard because its inferred
    // category was empty, and was then stamped with whatever had been asked for
    // — so one car with no Category field came back under A, under LX, and under
    // codes that do not exist, each time labelled as though it belonged.
    const { Category: _C, ...base } = car();
    install([{ ...base, Model: 'Bugatti Chiron' }, car({ Model: 'Fiat Panda', Category: 'A' })]);

    expect(await models({ category: 'A' })).toEqual(['Fiat Panda']);
    expect(await models({ category: 'B' })).toEqual([]);
    expect(await models({ category: 'LX' })).toEqual([]);
    expect(await models({ category: 'ZZZ' })).toEqual([]);
  });

  test('but it is still listed when no category is asked for', async () => {
    // Hiding it everywhere would lose the car from the site altogether; the desk
    // still needs to see that it exists.
    const { Category: _C, ...base } = car();
    install([{ ...base, Model: 'Bugatti Chiron' }]);
    expect(await models({})).toEqual(['Bugatti Chiron']);
  });

  test('a stored category beats the guess', async () => {
    // The map says Mercedes CLA is LX; this row says otherwise and the row wins.
    install([car({ Model: 'Mercedes CLA', Category: 'B' })]);
    expect(await models({ category: 'B' })).toEqual(['Mercedes CLA']);
    expect(await models({ category: 'LX' })).toEqual([]);
  });
});

describe('asking by vehicle instead of by category', () => {
  // Stored lower-case on purpose: the endpoint upper-cases what it reads off the
  // vehicle before comparing, and an already-upper-case fixture would not notice
  // if it stopped.
  const vehicle = { _id: 'veh-1', category: 'lx', title: 'LX - Mercedes CLA' };

  test('the vehicle\'s category is used', async () => {
    install([car({ Model: 'Mercedes CLA', Category: 'LX' }), car({ Model: 'Fiat Panda', Category: 'A' })], [vehicle]);
    expect(await models({ vehicleId: 'veh-1' })).toEqual(['Mercedes CLA']);
  });

  test('an explicit category wins over the vehicle\'s', async () => {
    install([car({ Model: 'Mercedes CLA', Category: 'LX' }), car({ Model: 'Fiat Panda', Category: 'A' })], [vehicle]);
    expect(await models({ vehicleId: 'veh-1', category: 'A' })).toEqual(['Fiat Panda']);
  });

  test('a vehicle id that matches nothing falls back to the whole fleet', async () => {
    // Worth stating plainly because it is the permissive direction: the lookup
    // failure is swallowed, so the category stays empty and the filter never
    // runs. A customer following a stale link sees everything rather than an
    // error or an empty page.
    install([car({ Model: 'Mercedes CLA', Category: 'LX' }), car({ Model: 'Fiat Panda', Category: 'A' })], [vehicle]);
    expect((await models({ vehicleId: 'no-such-vehicle' })).sort()).toEqual(['Fiat Panda', 'Mercedes CLA']);
  });

  test('a vehicle with no category behaves the same way', async () => {
    install([car({ Model: 'Fiat Panda', Category: 'A' })], [{ _id: 'veh-2', title: 'Something' }]);
    expect((await body({ vehicleId: 'veh-2' })).category).toBe('');
  });
});

describe('grouping the same model together', () => {
  test('two cars of the same model are one entry', async () => {
    install([
      car({ _id: 'f1', Model: 'Fiat Panda', Category: 'A' }),
      car({ _id: 'f2', Model: 'Fiat Panda', Category: 'A' }),
    ]);
    expect(await models({ category: 'A' })).toEqual(['Fiat Panda']);
  });

  test('the same model spelled differently still groups', async () => {
    install([
      car({ _id: 'f1', Model: 'Fiat Panda', Category: 'A' }),
      car({ _id: 'f2', Model: 'fiat-panda', Category: 'A' }),
    ]);
    expect((await body({ category: 'A' })).items).toHaveLength(1);
  });

  test('photos from every car of that model are pooled', async () => {
    install([
      car({ _id: 'f1', Model: 'Fiat Panda', Category: 'A', photos: 'https://img/1.jpg' }),
      car({ _id: 'f2', Model: 'Fiat Panda', Category: 'A', photos: 'https://img/2.jpg' }),
    ]);
    const [item] = (await body({ category: 'A' })).items;
    expect(item.photos).toEqual(['https://img/1.jpg', 'https://img/2.jpg']);
  });

  test('the same photo twice is only listed once', async () => {
    install([
      car({ _id: 'f1', Model: 'Fiat Panda', Category: 'A', photos: 'https://img/1.jpg' }),
      car({ _id: 'f2', Model: 'Fiat Panda', Category: 'A', photos: 'https://img/1.jpg' }),
    ]);
    const [item] = (await body({ category: 'A' })).items;
    expect(item.photos).toEqual(['https://img/1.jpg']);
  });

  test('one car listing the same photo under two fields lists it once', async () => {
    // The merge across cars and the de-duplication within a single car are two
    // different lines; this is the second, which the cross-car test above leaves
    // untouched. Rows carrying both `photos` and `image` are ordinary here.
    install([car({ Model: 'Fiat Panda', Category: 'A', photos: 'https://img/1.jpg', image: 'https://img/1.jpg' })]);
    const [item] = (await body({ category: 'A' })).items;
    expect(item.photos).toEqual(['https://img/1.jpg']);
  });

  test('no more than three photos are returned', async () => {
    install([car({ Model: 'Fiat Panda', Category: 'A', photos: ['1', '2', '3', '4', '5'].map((n) => `https://img/${n}.jpg`) })]);
    const [item] = (await body({ category: 'A' })).items;
    expect(item.photos).toHaveLength(3);
  });

  test('a later car can supply the category the first one lacked', async () => {
    const { Category: _C, ...noCategory } = car({ _id: 'f1', Model: 'Bugatti Chiron' });
    install([noCategory, car({ _id: 'f2', Model: 'Bugatti Chiron', Category: 'LX' })]);
    expect(await models({})).toEqual(['Bugatti Chiron']);
    expect((await body({})).items[0].category).toBe('LX');
  });
});

describe('the photo fields, of which there are many', () => {
  test.each([
    ['photos'], ['Photos'], ['gallery'], ['Gallery'], ['images'], ['Images'],
    ['album'], ['Album'], ['image'], ['Image'], ['photo'], ['Photo'],
  ])('%s is read', async (field) => {
    install([car({ Model: 'Fiat Panda', Category: 'A', [field]: 'https://img/1.jpg' })]);
    const [item] = (await body({ category: 'A' })).items;
    expect(item.photos).toEqual(['https://img/1.jpg']);
  });

  test('a wix image reference is turned into a fetchable URL', async () => {
    install([car({ Model: 'Fiat Panda', Category: 'A', photos: 'wix:image://v1/abc123~mv2.jpg/file.jpg#originWidth=1' })]);
    const [item] = (await body({ category: 'A' })).items;
    expect(item.photos).toEqual(['https://static.wixstatic.com/media/abc123~mv2.jpg']);
  });

  test('an object carrying src or url is read through it', async () => {
    install([car({ _id: 'f1', Model: 'Fiat Panda', Category: 'A', photos: { src: 'https://img/1.jpg' } })]);
    expect((await body({ category: 'A' })).items[0].photos).toEqual(['https://img/1.jpg']);

    fake.restore();
    install([car({ _id: 'f2', Model: 'Fiat Panda', Category: 'A', photos: { url: 'https://img/2.jpg' } })]);
    expect((await body({ category: 'A' })).items[0].photos).toEqual(['https://img/2.jpg']);
  });

  test('an image object is read through src, not scraped for its other fields', async () => {
    // A Wix image object carries width, height and alt alongside src. Walking the
    // values indiscriminately turns those into photo URLs.
    install([car({ Model: 'Fiat Panda', Category: 'A', photos: { src: 'https://img/1.jpg', alt: 'A photo', width: 800 } })]);
    expect((await body({ category: 'A' })).items[0].photos).toEqual(['https://img/1.jpg']);
  });

  test('a nested array of images is flattened', async () => {
    install([car({ Model: 'Fiat Panda', Category: 'A', photos: [['https://img/1.jpg'], [{ src: 'https://img/2.jpg' }]] })]);
    expect((await body({ category: 'A' })).items[0].photos).toEqual(['https://img/1.jpg', 'https://img/2.jpg']);
  });

  test('a car with no photos gets an empty list, not a missing field', async () => {
    install([car({ Model: 'Fiat Panda', Category: 'A' })]);
    expect((await body({ category: 'A' })).items[0].photos).toEqual([]);
  });
});

describe('the order they come back in', () => {
  test('models are sorted by name', async () => {
    install([
      car({ _id: 'f1', Model: 'Seat Ibiza', Category: 'A' }),
      car({ _id: 'f2', Model: 'Fiat Panda', Category: 'A' }),
      car({ _id: 'f3', Model: 'Opel Corsa', Category: 'A' }),
    ]);
    expect(await models({ category: 'A' })).toEqual(['Fiat Panda', 'Opel Corsa', 'Seat Ibiza']);
  });

  test('models named in Greek stay separate instead of collapsing into one', async () => {
    // They used to collapse. The grouping key stripped everything outside
    // [a-z0-9], so a name written entirely in Greek reduced to the empty string
    // and every such model shared one key — three cars came back as one, and the
    // other two disappeared from the site.
    install([
      car({ _id: 'f1', Model: 'Ωμέγα', Category: 'A' }),
      car({ _id: 'f2', Model: 'Άλφα', Category: 'A' }),
      car({ _id: 'f3', Model: 'Βήτα', Category: 'A' }),
      car({ _id: 'f4', Model: 'Fiat Panda', Category: 'A' }),
    ]);
    expect(await models({ category: 'A' })).toEqual(['Άλφα', 'Βήτα', 'Ωμέγα', 'Fiat Panda']);
  });

  test('a Greek name written two ways still groups', async () => {
    // The point of the key is not lost by keeping the letters: spacing and case
    // still fold together.
    install([
      car({ _id: 'f1', Model: 'Βαν Πολυτελείας', Category: 'A' }),
      car({ _id: 'f2', Model: 'βαν  πολυτελείας', Category: 'A' }),
    ]);
    expect((await body({ category: 'A' })).items).toHaveLength(1);
  });

  test('Greek model names sort by Greek rules, not by code point', async () => {
    install([
      car({ _id: 'f1', Model: 'Ωμέγα', Category: 'A' }),
      car({ _id: 'f2', Model: 'Άλφα', Category: 'A' }),
      car({ _id: 'f3', Model: 'Βήτα', Category: 'A' }),
    ]);
    expect(await models({ category: 'A' })).toEqual(['Άλφα', 'Βήτα', 'Ωμέγα']);
  });

  test('the order does not depend on the order the rows were stored in', async () => {
    const forwards = [
      car({ _id: 'f1', Model: 'Fiat Panda', Category: 'A' }),
      car({ _id: 'f2', Model: 'Seat Ibiza', Category: 'A' }),
    ];
    install(forwards);
    const a = await models({ category: 'A' });
    fake.restore();
    install([...forwards].reverse());
    expect(await models({ category: 'A' })).toEqual(a);
  });
});

describe('the photos a fleet model carries', () => {
  const photosOf = async (over) => {
    install([car(over)]);
    return (await body({})).items[0].photos;
  };

  test('a plain url is listed', async () => {
    expect(await photosOf({ photos: 'https://example.com/a.jpg' })).toEqual(['https://example.com/a.jpg']);
  });

  test('a Wix media reference is rewritten into a loadable URL', async () => {
    expect(await photosOf({ photos: 'wix:image://v1/abc123~mv2.jpg/car.jpg' }))
      .toEqual(['https://static.wixstatic.com/media/abc123~mv2.jpg']);
  });

  test.each([
    ['src', { src: 'https://example.com/a.jpg' }],
    ['url', { url: 'https://example.com/a.jpg' }],
  ])('an object exposing %s is unwrapped', async (_label, photos) => {
    expect(await photosOf({ photos })).toEqual(['https://example.com/a.jpg']);
  });

  test('an object with neither is walked for whatever it does hold', async () => {
    // Wix galleries arrive as objects keyed by index rather than as arrays, so
    // the values have to be walked or the whole gallery is lost.
    expect(await photosOf({ photos: { 0: 'https://example.com/a.jpg', 1: 'https://example.com/b.jpg' } }))
      .toEqual(['https://example.com/a.jpg', 'https://example.com/b.jpg']);
  });

  test('a nested structure is flattened', async () => {
    expect(await photosOf({
      photos: [['https://example.com/a.jpg', 'https://example.com/c.jpg'], { src: 'https://example.com/b.jpg' }],
    })).toEqual(['https://example.com/a.jpg', 'https://example.com/c.jpg', 'https://example.com/b.jpg']);
  });

  test('the alternative field spellings are all read', async () => {
    install([car({ Photos: 'https://example.com/a.jpg', gallery: 'https://example.com/b.jpg', Image: 'https://example.com/c.jpg' })]);

    expect((await body({})).items[0].photos).toEqual(expect.arrayContaining([
      'https://example.com/a.jpg', 'https://example.com/b.jpg', 'https://example.com/c.jpg',
    ]));
  });

  test.each([null, undefined, '', 0, false, {}])('%p contributes nothing', async (photos) => {
    expect(await photosOf({ photos })).toEqual([]);
  });

  test('a car with no photo fields at all lists none', async () => {
    expect(await photosOf({})).toEqual([]);
  });
});
