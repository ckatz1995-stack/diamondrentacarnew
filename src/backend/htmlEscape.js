// @ts-check
// Escapes the five HTML-significant characters. Shared by the contract document
// renderer and the fleet calendar, which each had their own identical copy.
//
// Ampersands must be replaced first — escaping them after the others would
// double-escape the entities just introduced.

/** @param {any} value */
export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
