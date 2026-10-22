# Kolo

A simple group expense splitter built with React, Express, and TypeScript. Data is stored locally in SQLite.

## Requirements

- Node.js 22.13 or newer (SQLite uses Node's built-in `node:sqlite` module)
- npm

## Run locally

From the repository root:

```sh
npm install
npm run dev
```

Open http://localhost:5173. Vite proxies `/api` requests to Express on port 3001.

## Build and run

```sh
npm run build
npm start
```

Open http://localhost:3001. Express serves the compiled React frontend and the API from the same origin.

## Checks

```sh
npm run check
npm test
```

The tests cover cent allocation, balances, repayments, authentication, ownership checks, input validation, expense changes, database persistence, and idempotent creation retries.

## Features

- Enter your email and press Login. Existing users sign in immediately. New users see a nickname field and a Register button; registration creates the account and signs them in. This prototype does not verify email ownership.
- Create groups shared with their members. The creator is added as the first participant and controls renaming and membership.
- Add existing users by email. Unknown emails are rejected with a request to register first. Added members can see the group and manage its expenses and repayments. The creator and participants with financial history cannot be removed.
- Add, edit, and delete USD expenses, choosing who paid and who shares the cost.
- Split equally in integer cents. Remainder cents go to selected participants in their creation order.
- View balances and suggested repayments. Positive balances mean the participant gets money back; negative balances mean they owe money.
- Record and delete repayments. These are bookkeeping records; no money moves through the app.
- Adding a participant does not change earlier expense splits.
- Retry an expense or repayment creation from the same open form without creating duplicates, including after a server restart. Closing and reopening the form starts a new creation attempt.
- Successful expense and repayment saves close the form even if refreshing balances fails; a message explains that the record was saved.
- Groups and balances refresh every 15 seconds while the page is visible and when it regains focus. Background refresh pauses while a form is open or an operation is in progress.

## Configuration and storage

The default database is `server/data/kolo.sqlite` when using the root npm commands. Its directory is created automatically; versioned migrations run when the backend starts. Database files are ignored by Git. Keep the database and its SQLite WAL files together when managing backups; stopping the server before copying the database is simplest.

Environment variables are read from the process environment (no automatic `.env` loading):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Express port; update the Vite proxy if changing this during development. |
| `DATABASE_PATH` | `data/kolo.sqlite` relative to the server working directory | SQLite file path; an absolute path is supported. |
| `COOKIE_SECURE` | `false` | Set to `true` only when serving through HTTPS. |

The backend binds to loopback for local use. No hosted services or deployment are required.


## TBD

- **Verify sign-in:** Replace email-only login with verified authentication, such as emailed sign-in links, before using real user data.
- **Handle expired sessions:** Return users to login and clear cached group data when a session expires or they sign out in another tab.
- **Prevent stale updates:** Cancel or ignore outdated requests so delayed responses cannot overwrite newer balances or display the wrong group after switching groups.
- **Detect conflicting edits:** Add expense versions and notify users when another member has changed a record since they opened it, instead of silently overwriting those changes.
- **Track financial changes:** Keep an audit history showing who created, edited, or deleted expenses and repayments, including the previous values.
- **Support multiple currencies:** Record expenses in other currencies. Define exchange rates and rounding rules so balances and repayments remain consistent in the group's default currency.
