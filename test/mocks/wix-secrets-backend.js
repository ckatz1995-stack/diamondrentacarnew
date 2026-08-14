// Minimal stand-in for the 'wix-secrets-backend' Velo backend module.
// Only exists so files under test that `import { getSecret } from 'wix-secrets-backend'`
// at module scope can load under Jest.
export function getSecret() {
  throw new Error('wix-secrets-backend mock: getSecret was not mocked for this test');
}
