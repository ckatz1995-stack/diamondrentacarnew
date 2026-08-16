import wixData from 'wix-data';
import { createFakeWixData } from '../../../test/helpers/fakeWixData.js';
import {
  getVehicleCategoriesCatalog, getVehicleCategoryDetails, getFleetModelsPreview,
} from '../bookingEngine.jsw';

// The three exports permissions.json marks anonymous-invokable: the catalogue a
// visitor browses, the detail behind one category, and the sample models shown
// for it. Everything here is reachable from the open internet with no session,
// and it is what a customer sees before they commit to a price.
//
// There is no auth to assert, so the risk is different in kind from the staff
// modules: showing something that should not be public, or failing to show
// something that should. An inactive category leaking into the list is a car
// nobody can book; one wrongly filtered out is a car nobody is offered.

function category(over = {}) {
  return {
    _id: 'cat-eco', category: 'ECO', title: 'Economy', price: 35, active: true,
    transmission: 'Manual', fuelType: 'Petrol', seats: 5, doors: 5, airCondition: true,
    ...over,
  };
}

function fleetRow(over = {}) {
  return { _id: 'car-1', model: 'Aygo', category: 'ECO', active: true, ...over };
}

let fake;
function install(seed = {}) {
  fake = createFakeWixData({ VehiclesNew: [category()], FleetNew: [fleetRow()], ...seed }).install(wixData);
  return fake;
}

afterEach(() => {
  if (fake) fake.restore();
  fake = null;
});

describe('the public category catalogue', () => {
  test('lists an active category', async () => {
    install();
    const list = await getVehicleCategoriesCatalog();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ label: 'ECO', price: 35 });
  });

  test.each([
    ['active true', { active: true }, true],
    ['active absent', { active: undefined }, true],
    ['Active with a capital A', { active: undefined, Active: true }, true],
    ['active false', { active: false }, false],
    ['Active false with a capital A', { active: undefined, Active: false }, false],
  ])('a category with %s is %s published', async (_label, over, published) => {
    // Absent means published: a category added without the flag set should
    // still appear rather than vanish from the site.
    install({ VehiclesNew: [category(over)] });
    const list = await getVehicleCategoriesCatalog();
    expect(list.length === 1).toBe(published);
  });

  test.each([
    ['active absent', { active: undefined }, true],
    ['Active with a capital A', { active: undefined, Active: true }, true],
    ['Active false with a capital A', { active: undefined, Active: false }, false],
  ])('the detail endpoint agrees that %s means %s published', async (_label, over, published) => {
    // The same rule is written twice: inline in getVehicleCategoriesCatalog and
    // again as isVehicleCategoryActive, which the detail and preview endpoints
    // use. Testing only the list exercises one copy — the two could disagree
    // about an absent or capital-A flag and the catalogue would offer a
    // category whose detail page returns null.
    install({ VehiclesNew: [category(over)] });
    const detail = await getVehicleCategoryDetails({ categoryCode: 'ECO' });
    expect(detail !== null).toBe(published);
  });

  test.each([
    ['active absent', { active: undefined }, 1],
    ['Active false with a capital A', { active: undefined, Active: false }, 0],
  ])('the model preview agrees that %s yields %i sample(s)', async (_label, over, count) => {
    install({ FleetNew: [fleetRow(over)] });
    const result = await getFleetModelsPreview({ categoryCode: 'ECO' });
    expect(result.items).toHaveLength(count);
  });

  test('categories are ordered cheapest first', async () => {
    // The booking page presents them in this order; reversing it puts the most
    // expensive car in front of every visitor.
    install({
      VehiclesNew: [
        category({ _id: 'cat-lux', category: 'LUX', title: 'Luxury', price: 120 }),
        category({ _id: 'cat-eco', category: 'ECO', title: 'Economy', price: 35 }),
        category({ _id: 'cat-cmp', category: 'CMP', title: 'Compact', price: 55 }),
      ],
    });
    expect((await getVehicleCategoriesCatalog()).map((c) => c.price)).toEqual([35, 55, 120]);
  });

  test('an empty catalogue is an empty list, not a failure', async () => {
    install({ VehiclesNew: [] });
    await expect(getVehicleCategoriesCatalog()).resolves.toEqual([]);
  });

  test('the specs a visitor compares on are carried through', async () => {
    install();
    const [item] = await getVehicleCategoriesCatalog();
    expect(item.specs).toMatchObject({ gearbox: 'Manual', fuel: 'Petrol', seats: 5, doors: 5 });
  });
});

describe('one category by id or code', () => {
  test('is found by its record id', async () => {
    install();
    expect(await getVehicleCategoryDetails({ vehicleId: 'cat-eco' })).toMatchObject({ label: 'ECO' });
  });

  test('is found by its category code', async () => {
    install();
    expect(await getVehicleCategoryDetails({ categoryCode: 'ECO' })).toMatchObject({ label: 'ECO' });
  });

  test('an inactive category is not served by id', async () => {
    // Otherwise a stale link keeps a withdrawn category bookable.
    install({ VehiclesNew: [category({ active: false })] });
    expect(await getVehicleCategoryDetails({ vehicleId: 'cat-eco' })).toBeNull();
  });

  test('an inactive category is not served by code either', async () => {
    install({ VehiclesNew: [category({ active: false })] });
    expect(await getVehicleCategoryDetails({ categoryCode: 'ECO' })).toBeNull();
  });

  test('an unknown id or code returns null rather than throwing', async () => {
    install();
    expect(await getVehicleCategoryDetails({ vehicleId: 'nope' })).toBeNull();
    expect(await getVehicleCategoryDetails({ categoryCode: 'NOPE' })).toBeNull();
  });

  test('no id and no code returns null', async () => {
    install();
    expect(await getVehicleCategoryDetails({})).toBeNull();
    expect(await getVehicleCategoryDetails()).toBeNull();
  });

  test('an id that matches nothing falls through to the code', async () => {
    // The booking UI sends both when it has them; a stale id must not stop the
    // code from resolving.
    install();
    expect(await getVehicleCategoryDetails({ vehicleId: 'stale', categoryCode: 'ECO' }))
      .toMatchObject({ label: 'ECO' });
  });
});

describe('the sample models shown for a category', () => {
  test('lists the fleet models in that category', async () => {
    install({
      FleetNew: [fleetRow(), fleetRow({ _id: 'car-2', model: 'Picanto' })],
    });
    const result = await getFleetModelsPreview({ categoryCode: 'ECO' });
    expect(result.items.map((i) => i.model)).toEqual(['Aygo', 'Picanto']);
  });

  test('models are listed alphabetically', async () => {
    install({
      FleetNew: [
        fleetRow({ _id: 'car-1', model: 'Picanto' }),
        fleetRow({ _id: 'car-2', model: 'Aygo' }),
        fleetRow({ _id: 'car-3', model: 'Corsa' }),
      ],
    });
    const result = await getFleetModelsPreview({ categoryCode: 'ECO' });
    expect(result.items.map((i) => i.model)).toEqual(['Aygo', 'Corsa', 'Picanto']);
  });

  test('a model held several times over is shown once', async () => {
    // A branch with four identical Aygos should offer "Aygo", not four of them.
    install({
      FleetNew: [
        fleetRow({ _id: 'car-1', model: 'Aygo' }),
        fleetRow({ _id: 'car-2', model: 'Aygo' }),
        fleetRow({ _id: 'car-3', model: 'Aygo' }),
      ],
    });
    const result = await getFleetModelsPreview({ categoryCode: 'ECO' });
    expect(result.items).toHaveLength(1);
  });

  test('the same model spelled with different capitals is still one entry', async () => {
    install({
      FleetNew: [fleetRow({ _id: 'car-1', model: 'Aygo' }), fleetRow({ _id: 'car-2', model: 'AYGO' })],
    });
    expect((await getFleetModelsPreview({ categoryCode: 'ECO' })).items).toHaveLength(1);
  });

  test('models from another category are left out', async () => {
    install({
      FleetNew: [fleetRow(), fleetRow({ _id: 'car-2', model: 'Passat', category: 'LUX' })],
    });
    const result = await getFleetModelsPreview({ categoryCode: 'ECO' });
    expect(result.items.map((i) => i.model)).toEqual(['Aygo']);
  });

  test('an inactive vehicle is not offered as a sample', async () => {
    install({
      FleetNew: [fleetRow(), fleetRow({ _id: 'car-2', model: 'Retired', active: false })],
    });
    const result = await getFleetModelsPreview({ categoryCode: 'ECO' });
    expect(result.items.map((i) => i.model)).toEqual(['Aygo']);
  });

  test('a fleet row with no model is skipped rather than shown blank', async () => {
    install({
      FleetNew: [fleetRow(), fleetRow({ _id: 'car-2', model: '' })],
    });
    expect((await getFleetModelsPreview({ categoryCode: 'ECO' })).items).toHaveLength(1);
  });

  test('a category with no vehicles returns an empty list, not a failure', async () => {
    install({ FleetNew: [] });
    const result = await getFleetModelsPreview({ categoryCode: 'ECO' });
    expect(result.items).toEqual([]);
    expect(result.category).toBeTruthy();
  });

  test('the category is resolved from a vehicle id when no code is given', async () => {
    install({ FleetNew: [fleetRow(), fleetRow({ _id: 'car-2', model: 'Passat', category: 'LUX' })] });
    const result = await getFleetModelsPreview({ vehicleId: 'cat-eco' });
    expect(result.items.map((i) => i.model)).toEqual(['Aygo']);
  });

  test('every model carries the category it belongs to', async () => {
    install();
    const [item] = (await getFleetModelsPreview({ categoryCode: 'ECO' })).items;
    expect(item.categoryCode).toBe('ECO');
    expect(item.category).toBe('ECO');
  });

  test('a model with no photo of its own falls back to the category image', async () => {
    // The grid looks broken with a gap in it, and the category picture is a
    // truthful stand-in for a car of that class.
    install({
      VehiclesNew: [category({ image: 'https://cdn.example/eco.jpg' })],
      FleetNew: [fleetRow()],
    });
    const [item] = (await getFleetModelsPreview({ categoryCode: 'ECO' })).items;
    expect(item.image).toBe('https://cdn.example/eco.jpg');
  });

  test('a model prefers its own photo over the category image', async () => {
    install({
      VehiclesNew: [category({ image: 'https://cdn.example/eco.jpg' })],
      FleetNew: [fleetRow({ photos: ['https://cdn.example/aygo.jpg'] })],
    });
    const [item] = (await getFleetModelsPreview({ categoryCode: 'ECO' })).items;
    expect(item.image).toBe('https://cdn.example/aygo.jpg');
  });

  test('photos from duplicate rows of one model are pooled', async () => {
    install({
      FleetNew: [
        fleetRow({ _id: 'car-1', model: 'Aygo', photos: ['https://cdn.example/a.jpg'] }),
        fleetRow({ _id: 'car-2', model: 'Aygo', photos: ['https://cdn.example/b.jpg'] }),
      ],
    });
    const [item] = (await getFleetModelsPreview({ categoryCode: 'ECO' })).items;
    expect(item.photos).toEqual(expect.arrayContaining([
      'https://cdn.example/a.jpg', 'https://cdn.example/b.jpg',
    ]));
  });

  test('the same photo listed twice appears once', async () => {
    install({
      FleetNew: [
        fleetRow({ _id: 'car-1', model: 'Aygo', photos: ['https://cdn.example/a.jpg'] }),
        fleetRow({ _id: 'car-2', model: 'Aygo', photos: ['https://cdn.example/a.jpg'] }),
      ],
    });
    const [item] = (await getFleetModelsPreview({ categoryCode: 'ECO' })).items;
    expect(item.photos.filter((p) => p === 'https://cdn.example/a.jpg')).toHaveLength(1);
  });

  test('specs come from the vehicle, falling back to the category', async () => {
    install({
      VehiclesNew: [category({ transmission: 'Manual', seats: 5 })],
      FleetNew: [fleetRow({ transmission: 'Automatic' })],
    });
    const [item] = (await getFleetModelsPreview({ categoryCode: 'ECO' })).items;
    expect(item.specs.gearbox).toBe('Automatic'); // the actual car
    expect(item.specs.seats).toBe(5);             // inherited from the category
  });

  test('a missing spec reads as a dash rather than as undefined', async () => {
    install({
      VehiclesNew: [category({ transmission: '', fuelType: '' })],
      FleetNew: [fleetRow({ transmission: '', fuelType: '' })],
    });
    const [item] = (await getFleetModelsPreview({ categoryCode: 'ECO' })).items;
    expect(item.specs.gearbox).toBe('-');
    expect(item.specs.fuel).toBe('-');
  });

  test('a mismatched vehicle id does not lend its photo to another category', async () => {
    // When vehicleId and categoryCode disagree, the code decides which models
    // are listed, so it decides the fallback image too. This used to let the id
    // supply the picture: an economy model shown wearing the luxury car's
    // photograph, beside the economy price.
    install({
      VehiclesNew: [
        category({ _id: 'cat-lux', category: 'LUX', title: 'Luxury', price: 120, image: 'https://cdn.example/luxury.jpg' }),
        category({ _id: 'cat-eco', category: 'ECO', title: 'Economy', price: 35 }),
      ],
      FleetNew: [fleetRow()],
    });
    const result = await getFleetModelsPreview({ vehicleId: 'cat-lux', categoryCode: 'ECO' });

    expect(result.items.map((i) => i.model)).toEqual(['Aygo']);
    expect(result.items[0].photos).not.toContain('https://cdn.example/luxury.jpg');
  });

  test('a mismatched id still falls back to the requested category own photo', async () => {
    // Dropping the stale id must not cost the correct image.
    install({
      VehiclesNew: [
        category({ _id: 'cat-lux', category: 'LUX', title: 'Luxury', price: 120, image: 'https://cdn.example/luxury.jpg' }),
        category({ _id: 'cat-eco', category: 'ECO', title: 'Economy', price: 35, image: 'https://cdn.example/eco.jpg' }),
      ],
      FleetNew: [fleetRow()],
    });
    const result = await getFleetModelsPreview({ vehicleId: 'cat-lux', categoryCode: 'ECO' });
    expect(result.items[0].photos).toEqual(['https://cdn.example/eco.jpg']);
  });

  test('a matching vehicle id and code show the right photo', async () => {
    // The ordinary case, so the test above reads as the exception it is.
    install({
      VehiclesNew: [category({ image: 'https://cdn.example/eco.jpg' })],
      FleetNew: [fleetRow()],
    });
    const result = await getFleetModelsPreview({ vehicleId: 'cat-eco', categoryCode: 'ECO' });
    expect(result.items[0].photos).toEqual(['https://cdn.example/eco.jpg']);
  });

  test('asking for a category nobody stocks returns nothing rather than everything', async () => {
    // The filter is what keeps this honest: with it removed, a request for an
    // empty category would list the whole fleet.
    install({ FleetNew: [fleetRow(), fleetRow({ _id: 'car-2', model: 'Passat', category: 'LUX' })] });
    const result = await getFleetModelsPreview({ categoryCode: 'SUV' });
    expect(result.items).toEqual([]);
  });
});
