# Reflector

A **local-first** app that syncs your data across multiple **systems of
record**. Reflector connects to a system of record — today the **Google
Calendar API** — reads everything it has for your account into a local copy
made of plain JSON files, and keeps that copy synced in the background.
That local-first copy can itself live in another system of record you
control: your own **[remoteStorage](https://remotestorage.io/)** account,
instead of files on this server. More systems of record can be added over
time.

As a **side feature**, you can download the whole local copy as a **ZIP** at
any time.

It is built on:

- **[localthought/syncables](https://github.com/localthought/syncables)** — the
  sync engine. Reflector hands it an OpenAPI document and it discovers the
  resources, walks pagination on a full read, keeps a local copy in a pluggable
  storage adapter, and applies local-first `create`/`update`/`delete` writes
  that retry against the server in the background.
- **[localthought/overlays](https://github.com/localthought/overlays)** — the
  Google Calendar [OpenAPI Overlays](https://spec.openapis.org/overlay/v1.0.0.html)
  from [issue #140](https://github.com/localthought/overlays/issues/140)
  (`pagination-overlay.yaml` + `crud-causality-overlay.yaml`), which define how
  a client paginates and does CRUD against the Calendar API. They are vendored
  under [`spec/overlays/`](spec/overlays) and applied to the vendored Calendar
  OpenAPI document at startup.

Scaffolded from
[node-typescript-boilerplate](https://github.com/michielbdejong/node-typescript-boilerplate).

## What it does

1. **Connect** a system of record via OAuth 2.0 — currently your Google
   account.
2. **Sync** — pull the full dataset (calendar list and every event on every
   calendar) into a local JSON copy under `data/`, and keep it synced:
   - while a sync is in flight, the header shows how many changes are in
     flight;
   - on success it shows **"synced"**;
   - on failure a change is **rolled back** to its pre-sync value and a
     warning toast is shown.
3. **Choose where the local copy lives** — on this server, or in your own
   remoteStorage account.
4. **Download ZIP** (side feature) — a `.zip` of the full local copy: one
   JSON file per record, grouped by calendar and resource.

## Running

Requires Node `>= 22.11 < 23`.

```sh
npm install          # also builds the `syncables` git dependency (see below)
npm run build
npm start            # http://localhost:3000
```

### Configuration

Set these before starting (a `.env` is not loaded automatically — export them or
use your process manager):

| Variable                     | Required | Default                              | Purpose                                                          |
| ---------------------------- | -------- | ------------------------------------ | --------------------------------------------------------------- |
| `OAUTH_CLIENT_ID`            | yes      | —                                    | OAuth client id                                                 |
| `OAUTH_CLIENT_SECRET`        | yes      | —                                    | OAuth client secret                                             |
| `OAUTH_REDIRECT_URI`         | no       | `${BASE_URL}/auth/callback`          | Must match the redirect URI on the OAuth client                 |
| `BASE_URL`                   | no       | `http://localhost:${PORT}`           | Public origin of this server                                    |
| `PORT`                       | no       | `3000`                               | Listen port                                                     |
| `DATA_DIR`                   | no       | `./data`                             | Where the local-first JSON copy is written (local-files storage) |
| `TOKEN_STORE_PATH`           | no       | `${DATA_DIR}/tokens.json`            | Where the OAuth access + refresh tokens are stored              |
| `REMOTESTORAGE_STORE_PATH`   | no       | `${DATA_DIR}/remotestorage.json`     | Where a connected remoteStorage account is persisted            |
| `REMOTESTORAGE_MODULE`       | no       | `reflector`                          | remoteStorage module (top-level directory) data is written under |
| `REMOTESTORAGE_CLIENT_ID`    | no       | `${BASE_URL}`                        | OAuth `client_id` presented to the remoteStorage provider       |
| `REMOTESTORAGE_REDIRECT_URI` | no       | `${BASE_URL}/remotestorage/callback` | remoteStorage OAuth redirect URI                                |

The `OAUTH_*` names are generic; the historical `GOOGLE_CALENDAR_CLIENT_ID` /
`GOOGLE_CALENDAR_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` are still accepted as
fallbacks. Everything else about the API OAuth flow — endpoints, scopes, and the
API base — is read from the document's security scheme and `servers`, not from
env vars. (The `REMOTESTORAGE_*` values configure the separate OAuth flow to the
user's own remoteStorage provider, described below.)

In the [Google Cloud console](https://console.cloud.google.com/): create an
OAuth 2.0 Client (type “Web application”), enable the **Google Calendar API**,
and add `http://localhost:3000/auth/callback` as an authorized redirect URI.
The scopes requested are whatever the document's `oauth` security scheme
declares — for the vendored Calendar overlay that is `calendar`,
`userinfo.email`, and `openid`.

### Where tokens live

After the OAuth flow the access token and refresh token are persisted to
`TOKEN_STORE_PATH` (owner-only permissions, `0600`), so a connection survives a
restart; the refresh token is used to mint new access tokens automatically. The
browser holds only an opaque, httpOnly session cookie that is matched against
the stored session. `data/` and `tokens.json` are git-ignored.

## Storage: local files or remoteStorage

By default the local-first copy is written to `DATA_DIR` as one JSON file per
record. But because syncables only ever talks to a pluggable
[`StorageAdapter`](https://github.com/localthought/syncables), Reflector lets
you swap that on-disk store for **your own
[remoteStorage](https://remotestorage.io/) account** — your data then lives in
your storage, not on this server. This is what lets Reflector treat
remoteStorage as another system of record alongside Google Calendar.

Use the **Storage** button in the top bar and enter your user address
(`you@storage.example`). Reflector then:

1. **discovers** your storage via [WebFinger](https://datatracker.ietf.org/doc/html/draft-dejong-remotestorage#section-10)
   (`src/remotestorage/webfinger.ts`) — the storage root plus its OAuth endpoint;
2. sends you to your provider's **consent screen** (OAuth 2.0 implicit grant,
   scope `reflector:rw`) and receives a bearer token back at
   `/remotestorage/callback` (the token arrives in the URL fragment, so a tiny
   page reads it and posts it to the server);
3. stores every record as a document at
   `<storage-root>/reflector/<calendar>/<resource>/<id>` via
   `RemoteStorageAdapter` (`src/remotestorage/adapter.ts`), mirroring the
   on-disk layout but over the remoteStorage HTTP protocol.

**Sync** after connecting (or disconnecting) to repopulate the copy in its new
home. The **ZIP download** works the same either way — it packages whatever
the active backend holds. Choose *Use local files* in the Storage dialog to
switch back. The bearer token is a secret and is persisted (owner-only)
alongside the Google tokens, outside the data set the ZIP packages.

## How it fits together

```
Browser SPA (public/)
      │  REST /api/*
      ▼
Express server (src/server) ── SyncEngine (src/sync/engine.ts)
                                     │
                                     ├── ResourceModel (src/sync/resources.ts)
                                     │      · discovers collections, hierarchy,
                                     │        and id rules from `crudResources`
                                     │
                                     ├── syncables ApiClient  (the sync engine)
                                     │      · full read (pagination)
                                     │      · local-first create/update/delete
                                     │      · background retry
                                     │
                                     ├── StorageBackend (src/sync/storage.ts)
                                     │      · FileStorageAdapter → JSON files on disk, or
                                     │      · RemoteStorageAdapter → the user's remoteStorage
                                     │      · either one enumerated → the ZIP
                                     │
                                     └── TokenManager (src/oauth/authed-fetch.ts)
                                            · injects the bearer token
                                            · fills {calendarId} in the path
                                            · retargets to the API base from the
                                              document's `servers`
                                            · refreshes on 401
```

**Nothing in `src/` is specific to Google or to the Calendar API.** The whole
flow is driven by the OpenAPI document and its overlays:

- the **OAuth flow** (`src/oauth/`) is derived from the document's `oauth2`
  security scheme — authorization/token/refresh URLs, scopes, the extra
  authorization-request parameters (`x-authorization-params`), and the userinfo
  endpoint (`x-userinfo-url`) — plus the API base from `servers` (see
  `deriveAuthProfile`). Only the OAuth *client id/secret* are deployment config.
- which **resources** exist, their URLs, how a nested collection's parent id is
  resolved, and how new ids are minted all come from the CRUD-causality
  overlay's `crudResources` (see `discoverResourceModel`). The engine walks that
  hierarchy generically; the calendar/event vocabulary lives only in the server
  layer that presents it.

The OpenAPI document is prepared once at startup (`src/sync/document.ts`):

1. load the vendored `spec/google-calendar-v3.openapi.yaml`;
2. apply the overlays in `spec/overlays/` — `auth-overlay.yaml` (OAuth security
   scheme), `pagination-overlay.yaml`, and `crud-causality-overlay.yaml`
   (`src/sync/overlay.ts` supports the overlays' bracketed
   `$.paths['/…'].get` targets, which the parser bundled with syncables does
   not);
3. adapt the overlays' `incrementalSync` pagination schemes into the `pageToken`
   shape the released syncables understands — keeping the `pageToken` /
   `nextPageToken` mechanics that drive the full read;
4. pin each list response's item array to the field the overlay's
   `envelope.itemsField` declares (Google's `Events` schema also has a
   `defaultReminders` array, which would otherwise be mistaken for the items).

Each nested collection client is given the same document narrowed to just that
collection's paths, and its own storage namespace (the parent context, e.g. the
calendar id), so sibling parents don't overwrite each other's records.

## Development

```sh
npm run build          # tsc to build/
npm test               # vitest unit + integration tests
npm run lint           # eslint
npm run prettier:check # formatting
```

Tests include an end-to-end `SyncEngine` test that runs the real syncables
engine and the real overlays against an in-memory stand-in for the Google
Calendar API, covering paginated full read, local-first create/update/delete,
sync-status tracking, and rollback on failure.

### The `syncables` dependency

`syncables` is consumed as a git dependency and ships as TypeScript source with
no prebuilt output, so `npm install` runs `scripts/postinstall.mjs` to build it
once. If that step is skipped (e.g. `--ignore-scripts`), build it manually:

```sh
cd node_modules/syncables && npm install && npm run build:release
```

## License

Apache-2.0
