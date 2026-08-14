// @ts-check
export const COLLECTIONS = {
  bookings: 'BookingsNew',
  fleet: 'FleetNew',
  rentals: 'RentalsNew',
  vehicles: 'VehiclesNew'
};

export const ROUTES = {
  home: '/',
  categories: '/categories',
  options: '/options',
  booking: '/booking',
  checkoutAlias: '/checkout',
  success: '/success',
  terms: '/rental-terms'
};

export const PUBLIC_API_BASE = '/_functions';

export const PORTAL_SESSION_TTL_HOURS = 8;

export const SITE_CURRENCY = 'EUR';

export const SITE_NAME = 'Diamond Rent a Car';

export const PORTAL_LOCATIONS = [
  { id: 'thessaloniki-center', label: 'Θεσσαλονίκη — Κέντρο', address: 'Κέντρο Θεσσαλονίκης' },
  { id: 'airport-mkd', label: 'Αεροδρόμιο Μακεδονία', address: 'Αεροδρόμιο Μακεδονία, Θεσσαλονίκη' },
  { id: 'thessaloniki-port', label: 'Λιμάνι Θεσσαλονίκης', address: 'Λιμάνι Θεσσαλονίκης' },
  { id: 'hotel-delivery', label: 'Παράδοση στο ξενοδοχείο', address: 'Κατ\' οίκον παράδοση / παραλαβή' }
];
