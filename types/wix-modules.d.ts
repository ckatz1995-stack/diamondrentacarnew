// Ambient declarations for the Velo runtime modules.
//
// `wix sync-types` generates richer types into .wix/, but that requires Wix
// credentials and is gitignored, so CI cannot rely on it. These minimal
// declarations let tsc resolve the imports; they intentionally type the Wix
// surface loosely, because the value here is checking OUR code (argument counts,
// call shapes), not the SDK's.

declare module 'wix-data' {
  const wixData: any;
  export default wixData;
}

declare module 'wix-secrets-backend' {
  export function getSecret(name: string): Promise<string>;
}

declare module 'wix-users-backend' {
  const wixUsersBackend: any;
  export default wixUsersBackend;
}

declare module 'wix-fetch' {
  export function fetch(url: string, options?: any): Promise<any>;
}

declare module 'wix-window' {
  const wixWindow: any;
  export default wixWindow;
}

declare module 'wix-location' {
  const wixLocation: any;
  export default wixLocation;
}

declare module 'wix-router' {
  const wixRouter: any;
  export default wixRouter;
}

// Velo page-code global.
declare const $w: any;
