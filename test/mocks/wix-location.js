// Minimal stand-in for the 'wix-location' Velo frontend module.
// `path`, `url`, `query` and `to` are the surface the pages use; tests set them
// directly and read `to.mock.calls` to see where a redirect was aimed.
//
// `onChange` matters for the public pages, which re-broadcast their bridge
// payloads whenever the route changes under a client-side navigation. The
// registered handlers are exposed through `__emitChange` so a test can trigger
// one; each jest.resetModules() gives a fresh, empty list.
const changeHandlers = [];
const wixLocation = {
  path: [],
  url: '',
  query: {},
  to() {},
  onChange(handler) {
    if (typeof handler === 'function') changeHandlers.push(handler);
  },
  __emitChange(location = {}) {
    changeHandlers.forEach((handler) => handler(location));
  },
  __changeHandlerCount: () => changeHandlers.length,
};
export default wixLocation;
