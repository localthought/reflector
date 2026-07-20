# Zipper

A **local-first** web app for your Google Calendar. Zipper connects to your
Google account, reads everything the Google Calendar API has for you into a
local copy made of plain JSON files, and lets you browse and edit that copy.
Edits are applied locally first and then synced back to Google in the
background — while a sync is in flight the UI shows it's still syncing, and if
the sync fails the local change is rolled back and a warning is shown. You can
download the whole local copy as a **ZIP** at any time (hence _Zipper_).

It is built on:

- **[localthought/syncables](https://github.com/localthought/syncables)** — the
  sync engine. Zipper hands it an OpenAPI document and it discovers the
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

1. **Connect** your Google account via OAuth 2.0.
2. **Full read** — pull your calendar list and every event on every calendar
   into a local JSON copy under `data/`.
3. **Browse** the local copy in a simple viewer.
4. **Add / edit / delete** events. Each change is written locally _first_ and
   returns immediately, then synced to Google in the background:
   - while the sync is pending, the change shows a **“syncing…”** badge and the
     header shows how many changes are in flight;
   - on success it shows **“synced”**;
   - on failure the local change is **rolled back** to its pre-edit value and a
     warning toast is shown.
5. **Download ZIP** — a `.zip` of the full local copy: one JSON file per record,
   grouped by calendar and resource.

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

| Variable                        | Required | Default                            | Purpose                                            |
| ------------------------------- | -------- | ---------------------------------- | -------------------------------------------------- |
| `GOOGLE_CALENDAR_CLIENT_ID`     | yes      | —                                  | Google OAuth client id                             |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | yes      | —                                  | Google OAuth client secret                         |
| `GOOGLE_REDIRECT_URI`           | no       | `${BASE_URL}/auth/google/callback` | Must match the redirect URI on the OAuth client    |
| `BASE_URL`                      | no       | `http://localhost:${PORT}`         | Public origin of this server                       |
| `PORT`                          | no       | `3000`                             | Listen port                                        |
| `DATA_DIR`                      | no       | `./data`                           | Where the local-first JSON copy is written         |
| `TOKEN_STORE_PATH`              | no       | `${DATA_DIR}/tokens.json`          | Where the OAuth access + refresh tokens are stored |

In the [Google Cloud console](https://console.cloud.google.com/): create an
OAuth 2.0 Client (type “Web application”), enable the **Google Calendar API**,
and add `http://localhost:3000/auth/google/callback` as an authorized redirect
URI. The requested scopes are `calendar`, `userinfo.email`, and `openid`.

### Where tokens live

After the OAuth flow the access token and refresh token are persisted to
`TOKEN_STORE_PATH` (owner-only permissions, `0600`), so a connection survives a
restart; the refresh token is used to mint new access tokens automatically. The
browser holds only an opaque, httpOnly session cookie that is matched against
the stored session. `data/` and `tokens.json` are git-ignored.

## How it fits together

```
Browser SPA (public/)
      │  REST /api/*
      ▼
Express server (src/server) ── SyncEngine (src/sync/engine.ts)
                                     │
                                     ├── syncables ApiClient  (the sync engine)
                                     │      · full read (pagination)
                                     │      · local-first create/update/delete
                                     │      · background retry
                                     │
                                     ├── FileStorageAdapter (src/sync/file-storage.ts)
                                     │      · one JSON file per record → the ZIP
                                     │
                                     └── TokenManager (src/google/authed-fetch.ts)
                                            · injects the bearer token
                                            · fills {calendarId} in the path
                                            · retargets to the real Google API base
                                            · refreshes on 401
```

The Calendar OpenAPI document is prepared once at startup
(`src/sync/document.ts`):

1. load the vendored `spec/google-calendar-v3.openapi.yaml`;
2. apply both overlays (`src/sync/overlay.ts` supports the overlays' bracketed
   `$.paths['/…'].get` targets, which the parser bundled with syncables does
   not);
3. adapt the overlays' `incrementalSync` pagination schemes into the `pageToken`
   shape the released syncables understands — keeping the `pageToken` /
   `nextPageToken` mechanics that drive the full read;
4. pin each list response's item array to the field the overlay's
   `envelope.itemsField` declares (Google's `Events` schema also has a
   `defaultReminders` array, which would otherwise be mistaken for the items).

Each per-calendar events client is given the same document narrowed to just the
events paths, and its own storage namespace (the calendar id), so calendars
don't overwrite each other's events.

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
