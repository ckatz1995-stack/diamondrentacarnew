import wixData from 'wix-data';
import { currentMember } from 'wix-members-backend';

export const STAFF_COLLECTIONS = {
  users: 'StaffUsers',
  roles: 'StaffRoles',
  audit: 'StaffAuditLog'
};

const MODULES = ['bookings','rentals','customers','pricing','fleet','reports','financials'];
const ACTIONS = ['view','insert','edit','delete'];
const SPECIALS = [
  'cancelBooking',
  'cancelRental',
  'voidInvoice',
  'mergeCorporateCustomers',
  'mergeIndividualRenters',
  'mergeAgents',
  'mergeSuppliers',
  'manageStaff',
  'manageBusinessSettings',
  'overridePricing',
  'approveManualOverride',
  'viewChangeHistory'
];

function text(value, fallback = '') {
  const out = String(value ?? '').trim();
  return out || fallback;
}
function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const t = String(value ?? '').trim().toLowerCase();
  if (!t) return fallback;
  return ['1','true','yes','y','on'].includes(t);
}
function slugKey(value) {
  return String(value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .toLowerCase();
}
function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}
function nowIso() {
  return new Date().toISOString();
}
function safeJson(value) {
  try { return JSON.stringify(value ?? null); } catch (_) { return null; }
}
function buildPermField(moduleKey, action) {
  return `${moduleKey}${action.charAt(0).toUpperCase()}${action.slice(1)}`;
}
function normalizeRole(payload = {}) {
  const key = slugKey(payload.key || payload.label || payload.title);
  const role = {
    _id: payload._id,
    key,
    label: text(payload.label || payload.title || key),
    description: text(payload.description),
    active: toBool(payload.active, true),
    sortOrder: Number(payload.sortOrder ?? 9999) || 9999,
    systemRole: toBool(payload.systemRole, false),
    specialPermissions: Array.isArray(payload.specialPermissions)
      ? payload.specialPermissions.filter(Boolean).join('|')
      : text(payload.specialPermissions)
  };
  MODULES.forEach((moduleKey) => {
    ACTIONS.forEach((action) => {
      role[buildPermField(moduleKey, action)] = toBool(payload[buildPermField(moduleKey, action)], false);
    });
  });
  return role;
}
function normalizeUser(payload = {}) {
  return {
    _id: payload._id,
    email: normalizeEmail(payload.email),
    fullName: text(payload.fullName || payload.name || payload.email),
    roleKey: slugKey(payload.roleKey),
    active: toBool(payload.active, true),
    memberId: text(payload.memberId),
    notes: text(payload.notes),
    deactivatedAt: payload.deactivatedAt || null
  };
}
function parseSpecials(value) {
  return String(value || '')
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean);
}
function roleToView(role = {}) {
  const permissions = {};
  MODULES.forEach((moduleKey) => {
    permissions[moduleKey] = {};
    ACTIONS.forEach((action) => {
      permissions[moduleKey][action] = !!role[buildPermField(moduleKey, action)];
    });
  });
  return {
    ...role,
    permissions,
    specialPermissionsList: parseSpecials(role.specialPermissions)
  };
}

function defaultRoles() {
  const base = (key, label, description, active = true, systemRole = true) => normalizeRole({ key, label, description, active, systemRole });
  const admin = base('admin', 'Admin', 'Πλήρης πρόσβαση σε όλο το backoffice.');
  MODULES.forEach((moduleKey) => ACTIONS.forEach((action) => { admin[buildPermField(moduleKey, action)] = true; }));
  admin.specialPermissions = SPECIALS.join('|');

  const manager = base('manager', 'Manager', 'Διαχειριστική πρόσβαση χωρίς hard delete λογική.');
  ['bookings','rentals','customers','pricing','fleet','reports','financials'].forEach((moduleKey) => {
    manager[buildPermField(moduleKey, 'view')] = true;
    manager[buildPermField(moduleKey, 'insert')] = true;
    manager[buildPermField(moduleKey, 'edit')] = true;
  });
  manager.specialPermissions = ['cancelBooking','cancelRental','manageBusinessSettings','overridePricing','approveManualOverride','viewChangeHistory'].join('|');

  const desk = base('desk', 'Desk', 'Κρατήσεις, renters και day-to-day operations.');
  ['bookings','rentals','customers'].forEach((moduleKey) => {
    desk[buildPermField(moduleKey, 'view')] = true;
    desk[buildPermField(moduleKey, 'insert')] = true;
    desk[buildPermField(moduleKey, 'edit')] = true;
  });
  desk[buildPermField('fleet', 'view')] = true;
  desk.specialPermissions = ['cancelBooking','overridePricing'].join('|');

  const finance = base('finance', 'Finance', 'Οικονομικά, τιμολογήσεις και pricing review.');
  ['financials','reports','pricing','bookings','rentals'].forEach((moduleKey) => {
    finance[buildPermField(moduleKey, 'view')] = true;
    finance[buildPermField(moduleKey, 'edit')] = moduleKey === 'pricing' || moduleKey === 'financials';
  });
  finance.specialPermissions = ['voidInvoice','viewChangeHistory','approveManualOverride'].join('|');

  const viewer = base('viewer', 'Viewer', 'Read-only πρόσβαση για έλεγχο.');
  MODULES.forEach((moduleKey) => { viewer[buildPermField(moduleKey, 'view')] = true; });
  viewer.specialPermissions = 'viewChangeHistory';
  return [admin, manager, desk, finance, viewer];
}

async function bootstrapRoles() {
  const res = await wixData.query(STAFF_COLLECTIONS.roles).limit(100).find({ suppressAuth: true }).catch(() => ({ items: [] }));
  if ((res.items || []).length) return res.items;
  const inserted = [];
  for (const role of defaultRoles()) {
    inserted.push(await wixData.insert(STAFF_COLLECTIONS.roles, role, { suppressAuth: true }));
  }
  return inserted;
}

async function getCurrentIdentity() {
  try {
    const member = await currentMember.getMember({ fieldsets: ['FULL'] });
    const roles = await currentMember.getRoles().catch(() => []);
    const email = normalizeEmail(member?.loginEmail || member?.contactDetails?.emails?.[0]?.email || member?.memberName || '');
    return {
      memberId: String(member?._id || member?.id || ''),
      email,
      name: text(member?.profile?.nickname || member?.contactDetails?.firstName || member?.memberName || email),
      wixRoles: Array.isArray(roles) ? roles.map((r) => ({ id: r.id, name: r.name || r.title || '' })) : []
    };
  } catch (_) {
    return { memberId: '', email: '', name: '', wixRoles: [] };
  }
}

async function getRoleMap() {
  const rows = await bootstrapRoles();
  const activeRows = rows.filter((row) => row.active !== false);
  const map = new Map();
  activeRows.forEach((row) => map.set(String(row.key), roleToView(row)));
  return { rows: activeRows.map(roleToView), map };
}

async function getStaffUserByEmail(email) {
  if (!email) return null;
  const res = await wixData.query(STAFF_COLLECTIONS.users)
    .eq('email', normalizeEmail(email))
    .limit(2)
    .find({ suppressAuth: true })
    .catch(() => ({ items: [] }));
  return res.items?.[0] || null;
}

function hasPermission(roleView, moduleKey, action) {
  return !!roleView?.permissions?.[moduleKey]?.[action];
}
function hasSpecial(roleView, permissionKey) {
  return (roleView?.specialPermissionsList || []).includes(permissionKey);
}

const ROUTE_RULES = {
  home: { moduleKey: '', action: '', special: '', open: true },
  daily: { moduleKey: 'rentals', action: 'view', fallbackModules: ['bookings'] },
  bookings: { moduleKey: 'bookings', action: 'view' },
  fleet: { moduleKey: 'fleet', action: 'view' },
  contract: { moduleKey: 'rentals', action: 'view', fallbackModules: ['bookings'] },
  settings: { moduleKey: 'pricing', action: 'view', fallbackSpecials: ['manageBusinessSettings','manageStaff'] }
};

function routePermissionAllowed(roleView, routeKey) {
  const rule = ROUTE_RULES[routeKey] || ROUTE_RULES.home;
  if (rule.open) return true;
  if (!roleView) return false;
  if (rule.moduleKey && rule.action && hasPermission(roleView, rule.moduleKey, rule.action)) return true;
  if (Array.isArray(rule.fallbackModules)) {
    for (const mod of rule.fallbackModules) {
      if (hasPermission(roleView, mod, rule.action || 'view')) return true;
    }
  }
  if (Array.isArray(rule.fallbackSpecials)) {
    for (const special of rule.fallbackSpecials) {
      if (hasSpecial(roleView, special)) return true;
    }
  }
  return false;
}

function routeDeniedReason(routeKey) {
  const messages = {
    daily: 'Δεν έχεις πρόσβαση στο Daily View.',
    bookings: 'Δεν έχεις πρόσβαση στο Bookings Board.',
    fleet: 'Δεν έχεις πρόσβαση στο Fleet Chart.',
    contract: 'Δεν έχεις πρόσβαση στο Contract.',
    settings: 'Δεν έχεις πρόσβαση στα Business Settings & Preferences.'
  };
  return messages[routeKey] || 'Δεν έχεις πρόσβαση σε αυτή την ενότητα.';
}

export async function getBackroomSession({ routeKey = 'home' } = {}) {
  const identity = await getCurrentIdentity();
  const { rows: allRoles, map } = await getRoleMap();
  const staffRecord = identity.email ? await getStaffUserByEmail(identity.email) : null;
  const currentRole = staffRecord ? map.get(String(staffRecord.roleKey || '')) || null : null;
  const accessState = !identity.email
    ? 'loginRequired'
    : (!staffRecord || staffRecord.active === false || !currentRole ? 'accessDenied' : 'ready');
  const routeAllowed = accessState === 'ready' ? routePermissionAllowed(currentRole, String(routeKey || 'home')) : String(routeKey || 'home') === 'home';
  const deniedReason = accessState === 'loginRequired'
    ? 'Για να μπεις στο backroom πρέπει πρώτα να κάνεις login ως site member.'
    : (routeAllowed ? '' : routeDeniedReason(String(routeKey || 'home')));

  return {
    routeKey: String(routeKey || 'home'),
    accessState,
    canAccessRequestedRoute: !!routeAllowed,
    needsLogin: accessState === 'loginRequired',
    deniedReason,
    currentStaff: identity.email ? {
      email: identity.email,
      name: identity.name,
      memberId: identity.memberId,
      wixRoles: identity.wixRoles,
      roleKey: staffRecord?.roleKey || '',
      roleLabel: currentRole?.label || '',
      specialPermissions: currentRole?.specialPermissionsList || [],
      permissionsSummary: currentRole ? summarizeRole(currentRole) : []
    } : null,
    routeAccess: {
      home: accessState === 'ready',
      daily: accessState === 'ready' && routePermissionAllowed(currentRole, 'daily'),
      bookings: accessState === 'ready' && routePermissionAllowed(currentRole, 'bookings'),
      fleet: accessState === 'ready' && routePermissionAllowed(currentRole, 'fleet'),
      contract: accessState === 'ready' && routePermissionAllowed(currentRole, 'contract'),
      settings: accessState === 'ready' && routePermissionAllowed(currentRole, 'settings')
    },
    meta: {
      note: 'Χρησιμοποίησε προσωπικό account ανά εργαζόμενο. Οι χρήστες απενεργοποιούνται αντί να διαγράφονται για να διατηρείται το audit trail.',
      rolesLoaded: allRoles.length
    }
  };
}

export async function assertStaffPermission({ moduleKey = 'pricing', action = 'view', special = '' } = {}) {
  const identity = await getCurrentIdentity();
  if (!identity.email) throw new Error('LOGIN_REQUIRED');
  const staffRecord = await getStaffUserByEmail(identity.email);
  if (!staffRecord || staffRecord.active === false) throw new Error('ACCESS_DENIED');
  const { map } = await getRoleMap();
  const roleView = map.get(String(staffRecord.roleKey || '')) || null;
  if (!roleView || roleView.active === false) throw new Error('ACCESS_DENIED');
  const allowed = hasPermission(roleView, moduleKey, action) || (special && hasSpecial(roleView, special));
  if (!allowed) throw new Error('ACCESS_DENIED');
  return { identity, staffRecord, roleView };
}

async function writeAudit(entry = {}) {
  try {
    await wixData.insert(STAFF_COLLECTIONS.audit, {
      entityType: text(entry.entityType),
      entityId: text(entry.entityId),
      action: text(entry.action),
      summary: text(entry.summary),
      oldValue: safeJson(entry.oldValue),
      newValue: safeJson(entry.newValue),
      actorEmail: normalizeEmail(entry.actorEmail),
      actorName: text(entry.actorName),
      createdAt: new Date(),
      retentionUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    }, { suppressAuth: true });
  } catch (_) {}
}

async function getAuditRows(limit = 40) {
  const res = await wixData.query(STAFF_COLLECTIONS.audit)
    .descending('createdAt')
    .limit(limit)
    .find({ suppressAuth: true })
    .catch(() => ({ items: [] }));
  return res.items || [];
}

async function getStaffUsers() {
  const res = await wixData.query(STAFF_COLLECTIONS.users)
    .ascending('fullName')
    .limit(200)
    .find({ suppressAuth: true })
    .catch(() => ({ items: [] }));
  return res.items || [];
}

function summarizeRole(roleView) {
  const modules = MODULES.map((moduleKey) => {
    const flags = ACTIONS.filter((action) => hasPermission(roleView, moduleKey, action)).map((a) => a.charAt(0).toUpperCase());
    return { key: moduleKey, flags };
  });
  return modules;
}

export async function getStaffAccessSnapshot() {
  const identity = await getCurrentIdentity();
  const { rows: allRoles, map } = await getRoleMap();
  const staffRecord = identity.email ? await getStaffUserByEmail(identity.email) : null;
  const currentRole = staffRecord ? map.get(String(staffRecord.roleKey || '')) || null : null;
  const accessState = !identity.email ? 'loginRequired' : (!staffRecord || staffRecord.active === false || !currentRole || !hasPermission(currentRole, 'pricing', 'view') ? 'accessDenied' : 'ready');
  const canManageStaff = accessState === 'ready' && hasSpecial(currentRole, 'manageStaff');
  const canViewAudit = accessState === 'ready' && (hasSpecial(currentRole, 'viewChangeHistory') || canManageStaff);
  const roles = accessState === 'ready' ? allRoles : [];
  const users = accessState === 'ready' ? await getStaffUsers() : [];
  const auditRows = canViewAudit ? await getAuditRows(50) : [];

  return {
    accessState,
    currentStaff: identity.email ? {
      email: identity.email,
      name: identity.name,
      memberId: identity.memberId,
      wixRoles: identity.wixRoles,
      roleKey: staffRecord?.roleKey || '',
      roleLabel: currentRole?.label || '',
      canManageStaff,
      canViewAudit,
      permissionsSummary: currentRole ? summarizeRole(currentRole) : [],
      specialPermissions: currentRole?.specialPermissionsList || []
    } : null,
    roles,
    users,
    auditRows,
    meta: {
      modules: MODULES,
      actions: ACTIONS,
      specialPermissions: SPECIALS,
      note: 'Οι χρήστες απενεργοποιούνται αντί να διαγράφονται, ώστε να παραμένει το ιστορικό αλλαγών.'
    }
  };
}

async function assertUniqueRoleKey(key, excludeId = '') {
  const normalizedKey = slugKey(key);
  if (!normalizedKey) throw new Error('Το role key είναι υποχρεωτικό.');
  const res = await wixData.query(STAFF_COLLECTIONS.roles).eq('key', normalizedKey).limit(5).find({ suppressAuth: true });
  const hit = (res.items || []).find((item) => String(item._id || '') !== String(excludeId || ''));
  if (hit) throw new Error(`Υπάρχει ήδη role με key "${normalizedKey}".`);
  return normalizedKey;
}
async function assertUniqueUserEmail(email, excludeId = '') {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error('Το email είναι υποχρεωτικό.');
  const res = await wixData.query(STAFF_COLLECTIONS.users).eq('email', normalizedEmail).limit(5).find({ suppressAuth: true });
  const hit = (res.items || []).find((item) => String(item._id || '') !== String(excludeId || ''));
  if (hit) throw new Error(`Υπάρχει ήδη staff user με email "${normalizedEmail}".`);
  return normalizedEmail;
}

export async function upsertStaffRole(payload = {}) {
  const ctx = await assertStaffPermission({ moduleKey: 'pricing', action: 'edit', special: 'manageStaff' });
  const item = normalizeRole(payload);
  item.key = await assertUniqueRoleKey(item.key, item._id);
  const oldItem = item._id ? await wixData.get(STAFF_COLLECTIONS.roles, item._id, { suppressAuth: true }).catch(() => null) : null;
  const saved = item._id
    ? await wixData.update(STAFF_COLLECTIONS.roles, { ...oldItem, ...item }, { suppressAuth: true })
    : await wixData.insert(STAFF_COLLECTIONS.roles, item, { suppressAuth: true });
  await writeAudit({
    entityType: 'role',
    entityId: saved._id,
    action: item._id ? 'role.update' : 'role.create',
    summary: `${item._id ? 'Ενημερώθηκε' : 'Δημιουργήθηκε'} role ${saved.label}`,
    oldValue: oldItem,
    newValue: saved,
    actorEmail: ctx.identity.email,
    actorName: ctx.identity.name
  });
  return saved;
}

export async function upsertStaffUser(payload = {}) {
  const ctx = await assertStaffPermission({ moduleKey: 'pricing', action: 'edit', special: 'manageStaff' });
  const item = normalizeUser(payload);
  item.email = await assertUniqueUserEmail(item.email, item._id);
  if (!item.roleKey) throw new Error('Διάλεξε role για τον χρήστη.');
  const roleMap = (await getRoleMap()).map;
  if (!roleMap.has(item.roleKey)) throw new Error('Το role δεν βρέθηκε ή δεν είναι ενεργό.');
  const oldItem = item._id ? await wixData.get(STAFF_COLLECTIONS.users, item._id, { suppressAuth: true }).catch(() => null) : null;
  const saved = item._id
    ? await wixData.update(STAFF_COLLECTIONS.users, { ...oldItem, ...item }, { suppressAuth: true })
    : await wixData.insert(STAFF_COLLECTIONS.users, item, { suppressAuth: true });
  await writeAudit({
    entityType: 'user',
    entityId: saved._id,
    action: item._id ? 'user.update' : 'user.create',
    summary: `${item._id ? 'Ενημερώθηκε' : 'Δημιουργήθηκε'} staff user ${saved.email}`,
    oldValue: oldItem,
    newValue: saved,
    actorEmail: ctx.identity.email,
    actorName: ctx.identity.name
  });
  return saved;
}

export async function deactivateStaffUser({ itemId } = {}) {
  const ctx = await assertStaffPermission({ moduleKey: 'pricing', action: 'edit', special: 'manageStaff' });
  if (!itemId) throw new Error('Missing itemId');
  const oldItem = await wixData.get(STAFF_COLLECTIONS.users, itemId, { suppressAuth: true });
  const updated = await wixData.update(STAFF_COLLECTIONS.users, {
    ...oldItem,
    active: false,
    deactivatedAt: nowIso()
  }, { suppressAuth: true });
  await writeAudit({
    entityType: 'user',
    entityId: updated._id,
    action: 'user.deactivate',
    summary: `Απενεργοποιήθηκε ο χρήστης ${updated.email}`,
    oldValue: oldItem,
    newValue: updated,
    actorEmail: ctx.identity.email,
    actorName: ctx.identity.name
  });
  return updated;
}

export async function reactivateStaffUser({ itemId } = {}) {
  const ctx = await assertStaffPermission({ moduleKey: 'pricing', action: 'edit', special: 'manageStaff' });
  if (!itemId) throw new Error('Missing itemId');
  const oldItem = await wixData.get(STAFF_COLLECTIONS.users, itemId, { suppressAuth: true });
  const updated = await wixData.update(STAFF_COLLECTIONS.users, {
    ...oldItem,
    active: true,
    deactivatedAt: null
  }, { suppressAuth: true });
  await writeAudit({
    entityType: 'user',
    entityId: updated._id,
    action: 'user.reactivate',
    summary: `Επανενεργοποιήθηκε ο χρήστης ${updated.email}`,
    oldValue: oldItem,
    newValue: updated,
    actorEmail: ctx.identity.email,
    actorName: ctx.identity.name
  });
  return updated;
}
