import { bootPageController, createComponent } from '../../../test/helpers/bootPageController.js';
import { derivePasswordHash, randomHex } from '../../backend/staffAccess.jsw';
import { APP_ROUTES } from '../../public/appRoutes.js';

// The vehicle card: one fleet vehicle, its category, its rental history, and an
// edit form — all inside a single embedded frame.
//
// Two things distinguish it from the other backroom pages. It is gated at
// fleet/View but its save action needs fleet/Edit, so the page-level guard is
// deliberately weaker than what the screen can do and the backend has to hold
// that line on its own. And it takes the vehicle to show from the query string,
// which is the one input an operator can get wrong by hand.

const COMP = '#vehicleCardHtml';
const ADMIN = 'admin@example.com';
const VIEWER = 'viewer@example.com';
const OUTSIDER = 'sales@example.com';
const PASSWORD = 'correct-horse-battery';
const TRUSTED = 'https://editor.wix.com';
const PLATE = 'ABC-1234';

function seed() {
  const salt = randomHex(16);
  const cred = (email) => ({
    _id: `cred-${email}`, email, passwordSalt: salt,
    passwordHash: derivePasswordHash(PASSWORD, salt), active: true,
  });
  return {
    StaffRoles: [
      { _id: 'role-admin', key: 'admin', label: 'Administrator', active: true },
      // May open the card. May not save from it.
      { _id: 'role-viewer', key: 'viewer', label: 'Fleet viewer', active: true, fleetView: true, specialPermissions: '' },
      { _id: 'role-sales', key: 'sales', label: 'Sales', active: true, bookingsView: true, specialPermissions: '' },
    ],
    StaffUsers: [
      { _id: 'u-1', email: ADMIN, fullName: 'A Admin', roleKey: 'admin', active: true },
      { _id: 'u-2', email: VIEWER, fullName: 'A Viewer', roleKey: 'viewer', active: true },
      { _id: 'u-3', email: OUTSIDER, fullName: 'A Seller', roleKey: 'sales', active: true },
    ],
    StaffCredentials: [cred(ADMIN), cred(VIEWER), cred(OUTSIDER)],
    StaffSessions: [],
    StaffAuditLog: [],
    FleetNew: [{
      _id: 'fleet-1', fleetVehicleId: 'FV-1', plate: PLATE, model: 'Fiat Panda',
      categoryCode: 'ECO', categoryId: 'cat-1', active: true, status: 'available',
      mileage: 41000, fuelLevel: 80, excess: 700, notes: 'nothing outstanding',
    }],
    VehiclesNew: [{ _id: 'v-1', categoryRecordId: 'cat-1', categoryCode: 'ECO', title: 'Economy', price: 30, active: true }],
    RentalsNew: [{ _id: 'r-1', rentalId: 'R-1', bookingId: 'B-1', assignedVehicleId: 'fleet-1', rentalState: 'closed' }],
    BookingsNew: [{ _id: 'b-1', bookingId: 'B-1', bookingNumber: 'BK-0001', customerName: 'A Customer' }],
  };
}

let ctx;
let html;
let warns;

async function boot({
  email = ADMIN,
  query = { fleetVehicleId: 'FV-1' },
  component = null,
  bare = false,
  path = ['vehiclecard'],
} = {}) {
  html = component || createComponent(COMP);
  ctx = await bootPageController({
    importer: () => import('../Vehiclecard.i3kns.js'),
    components: bare ? {} : { [COMP]: html },
    seed: seed(),
    signInAs: email,
    password: PASSWORD,
    query,
    url: 'https://diamond.example/vehiclecard',
    path,
  });
  return ctx;
}

const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
const send = async (msg, origin = TRUSTED) => { await html.emitMessage({ origin, data: msg }); await flush(); };
const of = (type) => html.postedOfType(type);
const lastToast = () => of('toast').pop()?.message;
const lastCard = () => of('loadVehicleCardData').pop();
const navigatedTo = () => ctx.wixLocation.to.mock.calls.map((c) => c[0]);

beforeEach(() => { warns = jest.spyOn(console, 'warn').mockImplementation(() => {}); });

afterEach(async () => {
  if (ctx) await ctx.teardown();
  ctx = null;
  html = null;
  warns.mockRestore();
});

describe('the page guard', () => {
  test('an operator with fleet access gets the frame expanded to a working height', async () => {
    await boot();

    expect(html.expanded).toBe(1);
    expect(html.height).toBe(1400);
    expect(navigatedTo()).toEqual([]);
  });

  test('an operator without fleet access is bounced home, flagged as denied', async () => {
    await boot({ email: OUTSIDER });

    expect(navigatedTo()).toEqual([
      `${APP_ROUTES.home}?next=${encodeURIComponent('/vehiclecard')}&denied=1`,
    ]);
    expect(html.posted).toEqual([]);
    // The redirect is not the whole guard: the controller must also stop before
    // expanding the frame and binding its message handler, or the screen renders
    // underneath the navigation and answers messages on the way out.
    expect(html.expanded).toBe(0);
    expect(html.height).toBeUndefined();
  });

  test('a signed-out visitor is bounced home without the denied flag', async () => {
    html = createComponent(COMP);
    ctx = await bootPageController({
      importer: () => import('../Vehiclecard.i3kns.js'),
      components: { [COMP]: html },
      seed: seed(),
      query: { fleetVehicleId: 'FV-1' },
      url: 'https://diamond.example/vehiclecard',
      path: ['vehiclecard'],
    });

    expect(navigatedTo()).toEqual([`${APP_ROUTES.home}?next=${encodeURIComponent('/vehiclecard')}`]);
  });

  test('fleet view alone is enough to open the page', async () => {
    await boot({ email: VIEWER });

    expect(navigatedTo()).toEqual([]);
  });

  test('a page with no frame logs and stops', async () => {
    await boot({ bare: true });

    expect(warns).toHaveBeenCalledWith('[Vehicle Card] HtmlComponent not found', `Missing ${COMP}`);
  });

  test('a frame that refuses to expand is still wired up', async () => {
    const stubborn = createComponent(COMP, { expand() { throw new Error('locked'); } });
    await boot({ component: stubborn });
    await send({ type: 'vehicleCardReady' });

    expect(warns).toHaveBeenCalledWith('[Vehicle Card] expand/initial height failed', 'locked');
    expect(lastCard()).toBeTruthy();
  });
});

describe('loading the card', () => {
  test('the vehicle, its category and its rental history all arrive', async () => {
    await boot();
    await send({ type: 'vehicleCardReady' });

    const card = lastCard();
    expect(card.data.fleet).toMatchObject({ plate: PLATE, model: 'Fiat Panda', categoryCode: 'ECO' });
    expect(card.data.rentals).toEqual([expect.objectContaining({ rentalId: 'R-1', bookingNumber: 'BK-0001' })]);
    expect(card.context).toEqual({ user: 'A Admin', returnTab: 'fleet' });
  });

  test('the business id in the query works as well as the record id', async () => {
    await boot({ query: { id: 'fleet-1' } });
    await send({ type: 'vehicleCardReady' });

    expect(lastCard().data.fleet).toMatchObject({ plate: PLATE });
  });

  test('a query with no vehicle at all is reported rather than fetched', async () => {
    await boot({ query: {} });
    await send({ type: 'vehicleCardReady' });

    expect(lastToast()).toBe('Missing fleetVehicleId in URL.');
    expect(of('loadVehicleCardData')).toHaveLength(0);
  });

  test('a whitespace-only id is the page\'s problem, not the backend\'s', async () => {
    // The id is trimmed here as well as in the backend, so the two spellings
    // agree on every real id. They differ on a blank one: trimmed, the page
    // says what is wrong with the URL; untrimmed, the request goes out and
    // comes back as MISSING_FLEET_VEHICLE_ID, which tells an operator nothing.
    await boot({ query: { fleetVehicleId: '   ' } });
    await send({ type: 'vehicleCardReady' });

    expect(lastToast()).toBe('Missing fleetVehicleId in URL.');
  });

  test('an id with stray whitespace still finds the vehicle', async () => {
    await boot({ query: { fleetVehicleId: '  FV-1  ' } });
    await send({ type: 'vehicleCardReady' });

    expect(lastCard().data.fleet).toMatchObject({ plate: PLATE });
  });

  test('a vehicle that does not exist reports the backend error and blanks the form', async () => {
    await boot({ query: { fleetVehicleId: 'FV-NOPE' } });
    await send({ type: 'vehicleCardReady' });

    expect(lastToast()).toBe('FLEET_VEHICLE_NOT_FOUND');
    // The blank payload matters: without it the frame keeps showing the previous
    // vehicle's details under the new id.
    expect(lastCard().data).toEqual({ fleet: {}, category: {}, summary: {}, rentals: [] });
    expect(lastCard().context).toEqual({ user: 'A Admin' });
  });

  test('the return tab comes from the query and defaults to the fleet chart', async () => {
    await boot({ query: { fleetVehicleId: 'FV-1', from: 'bookings' } });
    await send({ type: 'vehicleCardReady' });

    expect(lastCard().context.returnTab).toBe('bookings');
  });

  test('a blank from= falls back to the fleet chart', async () => {
    await boot({ query: { fleetVehicleId: 'FV-1', from: '   ' } });
    await send({ type: 'vehicleCardReady' });

    expect(lastCard().context.returnTab).toBe('fleet');
  });

  test('an operator with no name is shown by email', async () => {
    await boot({ email: VIEWER });
    const users = ctx.fake.rows('StaffUsers');
    await ctx.wixData.update('StaffUsers', { ...users.find((u) => u.email === VIEWER), fullName: '' }, { suppressAuth: true });

    await send({ type: 'vehicleCardReady' });

    expect(lastCard().context.user).toBe('A Viewer');
  });
});

describe('saving the card', () => {
  test('an edit is written, confirmed, and the card reloaded from the store', async () => {
    await boot();
    await send({ type: 'vehicleCardReady' });

    await send({ type: 'saveVehicleCard', patch: { mileage: 42500, notes: 'new tyres' } });

    expect(lastToast()).toBe('Vehicle saved.');
    expect(of('saveState').pop().fleet).toMatchObject({ mileage: 42500 });
    // Reloaded rather than echoed: the second card payload is a fresh read.
    expect(of('loadVehicleCardData')).toHaveLength(2);
    expect(lastCard().data.fleet).toMatchObject({ mileage: 42500, notes: 'new tyres' });
    expect(ctx.fake.rows('FleetNew')[0]).toMatchObject({ mileage: 42500, notes: 'new tyres' });
  });

  test('an empty patch leaves the record as it was', async () => {
    await boot();
    await send({ type: 'saveVehicleCard' });

    expect(lastToast()).toBe('Vehicle saved.');
    expect(ctx.fake.rows('FleetNew')[0]).toMatchObject({ plate: PLATE, mileage: 41000 });
  });

  test('an operator who may only view is refused the save by the backend', async () => {
    // The page let them in — fleet/View is all it asks for. The refusal has to
    // come from saveVehicleCardData's own fleet/Edit check.
    await boot({ email: VIEWER });
    await send({ type: 'saveVehicleCard', patch: { mileage: 99999 } });

    expect(lastToast()).not.toBe('Vehicle saved.');
    expect(of('saveState')).toHaveLength(0);
    expect(ctx.fake.rows('FleetNew')[0].mileage).toBe(41000);
  });

  test('saving a vehicle that has gone away is reported', async () => {
    await boot({ query: { fleetVehicleId: 'FV-NOPE' } });
    await send({ type: 'saveVehicleCard', patch: { mileage: 1 } });

    expect(lastToast()).toBe('FLEET_VEHICLE_NOT_FOUND');
    expect(of('saveState')).toHaveLength(0);
  });
});

describe('resizing the frame', () => {
  beforeEach(async () => { await boot(); });

  test('a height inside the range is applied', async () => {
    await send({ type: 'resize', height: 2000 });

    expect(html.height).toBe(2000);
  });

  test('a short frame is held at the floor', async () => {
    await send({ type: 'resize', height: 200 });

    expect(html.height).toBe(900);
  });

  test('a tall frame is capped', async () => {
    await send({ type: 'resize', height: 99999 });

    expect(html.height).toBe(5000);
  });

  test('a missing or unparseable height still lands on the floor', async () => {
    // Unlike the other pages, this clamp has no finiteness guard: Number('tall')
    // is NaN, Math.max(NaN, 900) is NaN, and `if (h)` drops it — but a plain
    // missing height clamps 0 up to 900 and is applied.
    await send({ type: 'resize' });
    expect(html.height).toBe(900);

    html.height = 1400;
    await send({ type: 'resize', height: 'tall' });
    expect(html.height).toBe(1400);
  });

  test('a frame that rejects the height logs and carries on', async () => {
    const stubborn = createComponent(COMP);
    let set = 0;
    Object.defineProperty(stubborn, 'height', {
      set() { set += 1; if (set > 1) throw new Error('read only'); },
      get() { return undefined; },
    });
    await ctx.teardown();
    await boot({ component: stubborn });

    await send({ type: 'resize', height: 2000 });

    expect(warns).toHaveBeenCalledWith('[Vehicle Card] resize height set failed', 'read only');
  });
});

describe('leaving the page', () => {
  test('back returns to the fleet chart by default', async () => {
    await boot();
    await send({ type: 'back' });

    expect(navigatedTo()).toEqual([APP_ROUTES.fleet]);
  });

  test('back returns to the bookings board when that is where the operator came from', async () => {
    await boot({ query: { fleetVehicleId: 'FV-1', from: 'bookings' } });
    await send({ type: 'back' });

    expect(navigatedTo()).toEqual([APP_ROUTES.bookings]);
  });

  test('an unrecognised from= still returns to the fleet chart', async () => {
    await boot({ query: { fleetVehicleId: 'FV-1', from: 'elsewhere' } });
    await send({ type: 'back' });

    expect(navigatedTo()).toEqual([APP_ROUTES.fleet]);
  });

  test('logout ends the session, drops the token and goes to the backroom home', async () => {
    await boot();
    await send({ type: 'logout' });

    expect(navigatedTo()).toEqual([APP_ROUTES.home]);
    expect(ctx.fake.rows('StaffSessions').every((s) => s.active === false)).toBe(true);
    expect(ctx.storage.local.getItem('diamond.backroom.session')).toBeFalsy();
  });
});

describe('navigating from the card', () => {
  beforeEach(async () => { await boot(); });

  test.each(['home', 'daily', 'fleet', 'bookings', 'pricing', 'contract'])(
    'route %s is followed',
    async (route) => {
      await send({ type: 'navigate', route });

      expect(navigatedTo()).toEqual([APP_ROUTES[route]]);
    },
  );

  test('an unknown route goes nowhere', async () => {
    await send({ type: 'navigate', route: 'nowhere' });
    await send({ type: 'navigate' });

    expect(navigatedTo()).toEqual([]);
  });

  // Mutation survivors on this file, all equivalent and left as they are:
  //
  // - Narrowing the payload guard to `if (!msg) return;` changes nothing, since
  //   every branch below re-tests msg.type against a literal.
  // - `saveVehicleCard(msg.patch || {})` and `saveVehicleCard(msg.patch)` agree:
  //   saveVehicleCardData destructures `patch = {}`, which fires on undefined.
  // - `route &&` is now redundant with the hasOwnProperty check below it —
  //   ROUTES has no '' key — but it is cheap and states the intent.
  test('an inherited key is not a route', async () => {
    // ROUTES is a plain object, so ROUTES['constructor'] and ROUTES['toString']
    // resolve to functions rather than undefined. `if (target)` accepts them, and
    // wixLocation.to would be handed a function.
    await send({ type: 'navigate', route: 'constructor' });
    await send({ type: 'navigate', route: 'toString' });

    expect(navigatedTo()).toEqual([]);
  });

  test('opening a contract carries the booking and where to come back to', async () => {
    await send({ type: 'openContract', bookingId: 'B-1' });

    expect(navigatedTo()).toEqual([`${APP_ROUTES.contract}?bookingId=B-1&from=fleet`]);
  });

  test('a booking id with characters that need escaping is encoded', async () => {
    await send({ type: 'openContract', bookingId: 'B 1&x=2' });

    expect(navigatedTo()).toEqual([`${APP_ROUTES.contract}?bookingId=B+1%26x%3D2&from=fleet`]);
  });

  test('opening a contract with no booking goes nowhere', async () => {
    await send({ type: 'openContract' });
    await send({ type: 'openContract', bookingId: '   ' });

    expect(navigatedTo()).toEqual([]);
  });
});

describe('which messages are accepted', () => {
  beforeEach(async () => { await boot(); });

  test('an untrusted origin is refused', async () => {
    await send({ type: 'back' }, 'https://evil.example');

    expect(navigatedTo()).toEqual([]);
  });

  test('an origin-less message is accepted', async () => {
    await send({ type: 'back' }, '');

    expect(navigatedTo()).toEqual([APP_ROUTES.fleet]);
  });

  test('a JSON string payload is parsed', async () => {
    await send(JSON.stringify({ type: 'back' }));

    expect(navigatedTo()).toEqual([APP_ROUTES.fleet]);
  });

  test('an unparseable, empty or typeless payload is ignored', async () => {
    await send('{ not json');
    await send(null);
    await send({ bookingId: 'B-1' });

    expect(navigatedTo()).toEqual([]);
    expect(html.posted).toEqual([]);
  });
});
