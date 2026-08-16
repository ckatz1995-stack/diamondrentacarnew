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

// npm packages used by the contract document pipeline. In Velo these are
// installed through Wix's package manager rather than this repo's package.json,
// so they are declared loosely here purely so tsc can resolve the imports.
declare module 'pdfkit' {
  const PDFDocument: any;
  export default PDFDocument;
  export = PDFDocument;
}
declare module 'puppeteer' {
  const puppeteer: any;
  export default puppeteer;
  export = puppeteer;
}
declare module '@sendgrid/mail' {
  const sgMail: any;
  export default sgMail;
  export = sgMail;
}

declare module 'wix-http-functions' {
  export function ok(options?: any): any;
  export function badRequest(options?: any): any;
  export function serverError(options?: any): any;
  export function notFound(options?: any): any;
  export function response(options?: any): any;
  export function forbidden(options?: any): any;
}

declare module 'wix-members-frontend' {
  const wixMembersFrontend: any;
  export default wixMembersFrontend;
  export const authentication: any;
  export const currentMember: any;
}
declare module 'wix-storage' {
  export const local: any;
  export const session: any;
  export const memory: any;
}
declare module 'wix-storage-frontend' {
  export const local: any;
  export const session: any;
  export const memory: any;
}
