// Minimal stand-in for the 'wix-members-frontend' Velo module. Only the
// authentication surface masterPage uses is provided.
export const authentication = {
  loggedIn: false,
  async logout() {},
  async promptLogin() {},
};
export const currentMember = {
  async getMember() { return null; },
};
