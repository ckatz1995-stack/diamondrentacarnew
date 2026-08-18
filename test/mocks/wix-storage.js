// Minimal stand-in for the 'wix-storage' Velo frontend module.
// Real local/session storage in Velo is string-keyed and returns null for a
// missing key, which is what the backroom auth guard's `||` chain relies on.
function makeStore() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => { map.set(String(key), String(value)); },
    removeItem: (key) => { map.delete(String(key)); },
    clear: () => map.clear(),
    __map: map,
  };
}
export const local = makeStore();
export const session = makeStore();
export const memory = makeStore();
