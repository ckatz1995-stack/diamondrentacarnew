# Git Integration & Wix CLI <img align="left" src="https://user-images.githubusercontent.com/89579857/185785022-cab37bf5-26be-4f11-85f0-1fac63c07d3b.png">

This repo is part of Git Integration & Wix CLI, a set of tools that allows you to write, test, and publish code for your Wix site locally on your computer. 

Connect your site to GitHub, develop in your favorite IDE, test your code in real time, and publish your site from the command line.

## Set up this repository in your IDE
This repo is connected to a Wix site. That site tracks this repo's default branch. Any code committed and pushed to that branch from your local IDE appears on the site.

Before getting started, make sure you have the following things installed:
* [Git](https://git-scm.com/download)
* [Node](https://nodejs.org/en/download/), version 14.8 or later.
* [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm) or [yarn](https://yarnpkg.com/getting-started/install)
* An SSH key [added to your GitHub account](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/adding-a-new-ssh-key-to-your-github-account).

To set up your local environment and start coding locally, do the following:

1. Open your terminal and navigate to where you want to store the repo.
1. Clone the repo by running `git clone <your-repository-url>`.
1. Navigate to the repo's directory by running `cd <directory-name>`.
1. Install the repo's dependencies by running `npm install` or `yarn install`.
1. Install the Wix CLI by running `npm install -g @wix/cli` or `yarn global add @wix/cli`.  
   Once you've installed the CLI globally, you can use it with any Wix site's repo.

For more information, see [Setting up Git Integration & Wix CLI](https://support.wix.com/en/article/velo-setting-up-git-integration-wix-cli-beta).

## Write Velo code in your IDE
Once your repo is set up, you can write code in it as you would in any other non-Wix project. The repo's file structure matches the [public](https://support.wix.com/en/article/velo-working-with-the-velo-sidebar#public), [backend](https://support.wix.com/en/article/velo-working-with-the-velo-sidebar#backend), and [page code](https://support.wix.com/en/article/velo-working-with-the-velo-sidebar#page-code) sections in Editor X.

Learn more about [this repo's file structure](https://support.wix.com/en/article/velo-understanding-your-sites-github-repository-beta).

## Test your code with the Local Editor
The Local Editor allows you test changes made to your site in real time. The code in your local IDE is synced with the Local Editor, so you can test your changes before committing them to your repo. You can also change the site design in the Local Editor and sync it with your IDE.

Start the Local Editor by navigating to this repo's directory in your terminal and running `wix dev`.

For more information, see [Working with the Local Editor](https://support.wix.com/en/article/velo-working-with-the-local-editor-beta).

## Preview and publish with the Wix CLI
The Wix CLI is a tool that allows you to work with your site locally from your computer's terminal. You can use it to build a preview version of your site and publish it. You can also use the CLI to install [approved npm packages](https://support.wix.com/en/article/velo-working-with-npm-packages) to your site.

Learn more about [working with the Wix CLI](https://support.wix.com/en/article/velo-working-with-the-wix-cli-beta).

## Member Portal

Customers can view and manage their own bookings without creating a Wix account.

### Authentication

Sign-in requires **email address + booking reference number** (e.g. `RNT-2025-0001`). No OAuth, no passwords. A session token is issued on successful match and its SHA-256 hash is stored in `PortalSessions` with an 8-hour TTL — the token itself is never persisted, so a leaked sessions table yields nothing that can be presented as a session. Every subsequent API call is verified by hashing the supplied token and matching it against the stored hash.

### Files

| File | Purpose |
|---|---|
| `src/public/member-portal/index.html` | Self-contained portal UI (login, dashboard, modals) |
| `src/backend/memberPortal.jsw` | Backend functions: signIn, signOut, getCustomerProfile, getCustomerBookings, getBookingDetail, updateBooking, cancelBooking |
| `src/pages/MemberPortal.js` | Wix page bridge — relays postMessage events between the HTML component and the backend |

### PortalSessions collection schema

| Field | Type | Notes |
|---|---|---|
| `customerId` | Text | Reference to the customer (_id) |
| `tokenHash` | Text | SHA-256 hex of the session token. The token itself is never stored |
| `expiresAt` | Text | ISO 8601 — session expires after `PORTAL_SESSION_TTL_HOURS` |
| `createdAt` | Text | ISO 8601 |

> Rows written before the hashed-token change carry a plaintext `sessionToken`
> field and no `tokenHash`, so they no longer resolve — those sessions are
> effectively signed out and the rows age out within the 8-hour TTL.

### Bridge message contract

HTML → Page: `PORTAL_READY`, `SIGN_IN {email, bookingRef}`, `GET_BOOKINGS {customerId, sessionToken, filter}`, `GET_PROFILE`, `UPDATE_BOOKING {bookingId, changes, customerId, sessionToken}`, `CANCEL_BOOKING {bookingId, reason, customerId, sessionToken}`, `SIGN_OUT`

Page → HTML: `INIT {locations, currency, companyName, bookingPageUrl}`, `AUTH_RESULT`, `BOOKINGS_RESULT`, `PROFILE_RESULT`, `UPDATE_RESULT`, `CANCEL_RESULT`, `SIGN_OUT_RESULT`

## Invite contributors to work with you
Git Integration & Wix CLI extends Editor X's [concurrent editing](https://support.wix.com/en/article/editor-x-about-concurrent-editing) capabilities. Invite other developers as collaborators on your [site](https://support.wix.com/en/article/inviting-people-to-contribute-to-your-site) and your [GitHub repo](https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-access-to-your-personal-repositories/inviting-collaborators-to-a-personal-repository). Multiple developers can work on a site's code at once.

## Type checking

The backend is plain JavaScript, but TypeScript runs over it in `checkJs` mode to
catch a class of bug this codebase has hit repeatedly: an argument in the wrong
position that JavaScript accepts silently. Two real examples, both since fixed —
an options object passed as a third argument to a two-parameter function, and a
comma operator inside an object spread — are caught as `TS2554` and `TS2695`.

Run it with:

```
npm run typecheck
```

Two things to know:

- **Checking is opt-in per file.** `checkJs` is `false` in `tsconfig.json`; a file
  is only checked if it starts with `// @ts-check`. This keeps the checked set at
  zero errors and lets coverage grow a file at a time, rather than requiring a
  repo-wide annotation pass up front.
- **`.jsw` files need a mirror.** Velo requires web modules to keep the `.jsw`
  extension, and `tsc` silently ignores extensions it does not recognise — a
  tsconfig that "includes" `src/**/*.jsw` checks nothing and reports success. So
  `scripts/typecheck.mjs` mirrors `src/` into `.typecheck/` with `.jsw` renamed to
  `.js` before running `tsc`. Nothing about deployment changes.

To add a file to the checked set, put `// @ts-check` at the top and run
`npm run typecheck`. Most remaining errors are option-bag parameters that TS
cannot infer from `= {}` defaults; a JSDoc `@param` annotation resolves them.
