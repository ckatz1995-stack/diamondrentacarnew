// @ts-check
export function safeText(value) {
  return String(value ?? "").trim();
}

export function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function asDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

export function pickLabel(value) {
  if (!value) return "";
  if (typeof value === "object") return safeText(value.label || value.title || value.name || value.value || value._id || "");
  return safeText(value);
}

export function isLikelyId(value) {
  const s = safeText(value);
  return /^[0-9a-f]{8}-[0-9a-f-]{12,}$/i.test(s) || /^[0-9a-z]{20,}$/i.test(s);
}

export function extractCode(labelOrCode) {
  const s = safeText(labelOrCode);
  if (!s || isLikelyId(s)) return "";
  if (s.includes(" - ")) return safeText(s.split(" - ")[0]);
  const m = s.match(/^([A-Za-z0-9]+)/);
  return m ? safeText(m[1]) : safeText(s.split(/\s+/)[0]);
}

export function normalizeDateParam(value) {
  const raw = safeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}
