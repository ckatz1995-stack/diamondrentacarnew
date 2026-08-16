// Stand-in for Velo's wix-fetch. Records every call so tests can assert on the
// URL and payload a module sent, and lets each test decide what comes back —
// including a rejection, since "the notification service is down" is a case the
// callers are supposed to survive rather than propagate.

export const calls = [];

let handler = async () => ({
  status: 200,
  ok: true,
  json: async () => ({ ok: true, result: { message_id: 1 } }),
  text: async () => '{"ok":true}',
});

export async function fetch(url, options = {}) {
  calls.push({ url, options, body: safeParse(options.body) });
  return handler(url, options);
}

function safeParse(body) {
  if (typeof body !== 'string') return body;
  try { return JSON.parse(body); } catch (_) { return body; }
}

/** Replace what the next fetches resolve (or reject) with. */
export function setHandler(fn) { handler = fn; }

/** Convenience: resolve with this JSON body and status. */
export function respondWith(json, status = 200) {
  setHandler(async () => ({ status, ok: status >= 200 && status < 300, json: async () => json, text: async () => JSON.stringify(json) }));
}

export function reset() {
  calls.length = 0;
  setHandler(async () => ({
    status: 200,
    ok: true,
    json: async () => ({ ok: true, result: { message_id: 1 } }),
    text: async () => '{"ok":true}',
  }));
}

export default { fetch };
