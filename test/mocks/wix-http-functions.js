// Stand-in for Velo's wix-http-functions. Each helper is a status code plus the
// headers and body the caller supplied, so tests can assert on all three — which
// status a handler chose, whether it echoed an Access-Control-Allow-Origin, and
// what it actually returned. The real module builds a response object the Wix
// runtime serialises; the shape below is the part handlers can observe.

function responder(status) {
  return function build({ headers = {}, body } = {}) {
    return { status, headers: { ...headers }, body };
  };
}

export const ok = responder(200);
export const created = responder(201);
export const badRequest = responder(400);
export const forbidden = responder(403);
export const notFound = responder(404);
export const serverError = responder(500);

export function response({ status = 200, headers = {}, body } = {}) {
  return { status, headers: { ...headers }, body };
}
