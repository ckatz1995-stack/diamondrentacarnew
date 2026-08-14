// Minimal stand-in for the 'wix-users-backend' Velo backend module.
// Only exists so files under test that import it at module scope can load
// under Jest; tests needing real behavior should mock it per-test.
export default {
  currentUser: { id: '', loggedIn: false },
};
