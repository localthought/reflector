# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm install             # also builds the `syncables` git dependency (postinstall)
npm run build            # tsc -> build/
npm run dev               # build + start
npm start                  # NODE_OPTIONS=--enable-source-maps node build/src/main.js
npm test                    # vitest run unit --config __tests__/vitest.config.ts
npm run test:coverage        # same, with v8 coverage
npm run lint                  # eslint .
npm run prettier:check         # prettier --check
npm run prettier                # prettier --write
```

Run a single test file: `npx vitest run __tests__/unit/engine.test.ts --config __tests__/vitest.config.ts`
Run tests matching a name: `npx vitest run --config __tests__/vitest.config.ts -t "pattern"`

Node `>= 22.11 < 23` is required (see `engines` in package.json). Requires `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` to actually run the server locally (see README's Configuration table).

### The `syncables` dependency

`syncables` is a git dependency shipped as TS source with no prebuilt output. `npm install` builds it via `scripts/postinstall.mjs`. If that step was skipped (`--ignore-scripts`), build it manually:

```sh
cd node_modules/syncables && npm install && npm run build:release
```

## Architecture

Reflector is **not Google-Calendar-specific in `src/`**. The entire sync flow — OAuth, resource discovery, pagination, CRUD — is derived generically at startup from an OpenAPI document plus OpenAPI Overlays; only the server layer knows it's presenting calendars/events.

```
Browser SPA (public/)
      │  REST /api/*
      ▼
Express server (src/server) ── SyncEngine (src/sync/engine.ts)
                                     │
                                     ├── ResourceModel (src/sync/resources.ts)
                                     │      discovers collections/hierarchy/id rules from crudResources
                                     │
                                     ├── syncables ApiClient (external dep — the actual sync engine)
                                     │      full read w/ pagination, local-first create/update/delete,
                                     │      background retry
                                     │
                                     ├── StorageBackend (src/sync/storage.ts)
                                     │      FileStorageAdapter (JSON on disk) or
                                     │      RemoteStorageAdapter (user's remoteStorage) — either is
                                     │      what the ZIP download enumerates
                                     │
                                     └── TokenManager (src/oauth/authed-fetch.ts)
                                            injects bearer token, fills {calendarId} in the path,
                                            retargets to the API base from the document's `servers`,
                                            refreshes on 401
```

### Document preparation (`src/sync/document.ts`), run once at startup

1. Load the vendored `spec/google-calendar-v3.openapi.yaml`.
2. Apply overlays from `spec/overlays/`: `auth-overlay.yaml` (OAuth security scheme), `pagination-overlay.yaml`, `crud-causality-overlay.yaml`. `src/sync/overlay.ts` implements support for the overlays' bracketed `$.paths['/…'].get` targets — the parser bundled with `syncables` doesn't handle that syntax.
3. Adapt the overlays' `incrementalSync` pagination scheme into the `pageToken` shape the released `syncables` understands.
4. Pin each list response's item array to the field declared in the overlay's `envelope.itemsField` (e.g. Google's `Events` schema also has a `defaultReminders` array that would otherwise be mistaken for the items).

Each nested collection client gets the document narrowed to just that collection's paths, plus its own storage namespace (the parent context, e.g. calendar id) — so sibling parents don't clobber each other's records.

### OAuth is document-derived (`src/oauth/`)

`deriveAuthProfile` reads authorization/token/refresh URLs, scopes, extra `x-authorization-params`, the userinfo endpoint (`x-userinfo-url`), and the API base (`servers`) straight from the document's `oauth2` security scheme. Only the client id/secret are deployment config (`OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET`, with `GOOGLE_CALENDAR_CLIENT_ID`/`GOOGLE_CALENDAR_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI` accepted as legacy fallbacks).

### Resource discovery is document-derived (`src/sync/resources.ts`)

Which resources exist, their URLs, how a nested collection's parent id resolves, and how new ids are minted all come from the CRUD-causality overlay's `crudResources`. `discoverResourceModel` walks that hierarchy generically.

### Multi-user model

Each browser session is a separate connected user (opaque httpOnly session cookie), with its own OAuth tokens, its own local-first copy (`${DATA_DIR}/copies/<account>`), and its own `SyncEngine` — concurrent users never see or overwrite each other's data. A connected remoteStorage account is scoped to the single user who connected it.

Per-user record persistence is pluggable (`src/server/user-store.ts` vs `src/server/user-store-postgres.ts`):
- **Files** (default) — one owner-only JSON file per user under `${DATA_DIR}/users` (`USERS_DIR` to override). Needs a persistent disk.
- **Postgres** — set `DATABASE_URL`; users go into an auto-created `reflector_users` table instead. Needed on hosts with ephemeral disks (Heroku dyno, DO App Platform).

An instance upgraded from the earlier single-user build migrates its existing `tokens.json`/`remotestorage.json` into the file store on first start.

### remoteStorage as an alternate system of record

By default the local-first copy is plain JSON files under `DATA_DIR`. Since `syncables` only ever talks to a pluggable `StorageAdapter`, that can be swapped for the user's own [remoteStorage](https://remotestorage.io/) account instead:

1. discover the storage via WebFinger (`src/remotestorage/webfinger.ts`) — storage root + OAuth endpoint;
2. OAuth 2.0 implicit grant (scope `reflector:rw`) to the provider's consent screen, token returned at `/remotestorage/callback` (arrives in the URL fragment; a tiny page reads it and posts it to the server);
3. every record is stored as a document at `<storage-root>/reflector/<calendar>/<resource>/<id>` via `RemoteStorageAdapter` (`src/remotestorage/adapter.ts`), mirroring the on-disk layout over the remoteStorage HTTP protocol.

The bearer token is persisted owner-only alongside the Google tokens, outside the data set the ZIP packages. A resync is needed after switching backends to repopulate the copy in its new home.

## Testing

`npm test` runs `vitest run unit`, which covers only `__tests__/unit/**` (not `spec/`, which holds the vendored OpenAPI document and overlays, not tests). Notably `__tests__/unit/engine.test.ts` runs the real `syncables` engine and the real overlays against an in-memory stand-in for the Google Calendar API — covering paginated full read, local-first create/update/delete, sync-status tracking, and rollback on failure. Prefer extending that style of test (real engine + real overlays + fake HTTP) over mocking `syncables` internals when testing sync behavior.
