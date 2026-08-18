// Minimal stand-in for the 'wix-location' Velo frontend module.
// `path` and `to` are the only surface src/public uses; tests set path directly
// and read `to.mock.calls` to see where a redirect was aimed.
const wixLocation = {
  path: [],
  url: '',
  to() {},
};
export default wixLocation;
