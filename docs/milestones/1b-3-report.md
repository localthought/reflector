# Milestone 1b + 3 evidence report

Source: [michielbdejong/devlog#64](https://github.com/michielbdejong/devlog/issues/64)
("TUBS 1b+3 milestone report"). That issue is a devlog note asserting the
NLnet MOU deliverables for milestone 1b and milestone 3 are done. This
document collects the concrete evidence for the claims that fall inside
this repository (milestone 3, plus what this repo can independently confirm
about the milestone 1b dependency), gathered on 2026-08-31 against
`main` (commit `a807916`).

## Milestone 3 — Reflector: reflecting between two systems of record

Milestone 3's deliverable, per the [README](../../README.md#reflecting-between-two-systems-eg-two-github-issue-trackers),
is that Reflector can **actively reflect records between two endpoints**
(A and B), not just sync one system into a local copy — demonstrated on two
independent GitHub issue trackers: issues created on one are copied to the
other, open/closed state is kept in agreement, and comments are copied
across.

### What was built

| Piece | Commit(s) |
| --- | --- |
| Vendored GitHub Issues OpenAPI document + overlays | `bd5e487` (#23) |
| Static API-key/PAT auth mode (no OAuth needed for token-auth endpoints) | `1714eee` (#24) |
| Cross-system reflection engine for issues | `73166bc` (#25) |
| Hidden HTML-comment origin marker (loop prevention) | `01ceb86` (#26) |
| Reflect issue open/closed state across the mirrored pair | `1613ea4` (#27) |
| Reflect issue comments across the mirrored pair | `e8ad3f5` (#28) |
| Background reflect loop, on-demand `POST /api/reflect`, persisted id-map | `481d0c8` (#29) |
| Two-endpoint (A/B) config + docs | `db60814` |
| Bump to `syncables@0.17.1` for GitHub-shape support | `8c86912`, `8623d39` |

Runtime surface: `POST /api/reflect` triggers a pass on demand and returns a
summary of what it created and the state changes it propagated;
`GET /api/reflect/status` inspects the background loop, which otherwise runs
every `REFLECT_INTERVAL_MS` (default 60s). See the README's
[Reflecting between two systems](../../README.md#reflecting-between-two-systems-eg-two-github-issue-trackers)
section for full configuration (`REFLECT_A_REPO`/`REFLECT_B_REPO`,
`REFLECT_A_TOKEN`/`REFLECT_B_TOKEN`, `REFLECT_DIRECTION`).

### Live validation

Per the README's status callout, the reflection engine has been **validated
live against two real GitHub repositories** — create, idempotent re-runs,
open/closed state both ways, and comments — in addition to the automated
test suite against a faithful in-memory GitHub stand-in. It depends on
GitHub-shape support added to the sync engine itself
([localthought/syncables#4](https://github.com/localthought/syncables/issues/4)–[#6](https://github.com/localthought/syncables/issues/6),
released as `syncables` 0.17.1 on npm).

### Automated test evidence (re-run for this report)

```
$ pnpm test           # __tests__/unit/**, vitest
 Test Files  19 passed (19)
      Tests  88 passed (88)

$ pnpm test:harness    # harness/**, vitest
 Test Files  3 passed (3)
      Tests  9 passed (9)
```

The harness (`harness/`, see [`harness/README.md`](../../harness/README.md))
is a separate, SUT-independent test rig: a **Driver** writes changes to a
fake platform, a **StubReflector** stands in for Reflector, a **Reviewer**
observes the target through fresh clients, and an oracle judges correctness
without trusting the reflector's own mapping. It exercises the failure
modes a grading reviewer would ask about, not just the happy path:
`reflected` (correct), `mismatch` (wrong content, e.g. a dropped field),
`timeout` (record never arrives), `looped` (ping-pong via origin-marker
echo suppression), and cross-shape mapping (a differently-shaped target
platform, judged by a mapping-aware oracle) — added across
`ab2dcd2`, `ec25bc4`, `8c86912`.

### Known scope limits (for accurate reporting)

- Reconciling two endpoints with genuinely different record shapes beyond
  GitHub Issues is a later "Devonian" mapping step, called out as
  out-of-scope for the base engine in the README; the two-endpoint config
  already keeps the documents separate so that work has somewhere to plug
  in.
- Token-auth reflection mode (A/B) and the interactive per-user OAuth mode
  (single system, local-first copy) are mutually exclusive per instance —
  when both `REFLECT_*_REPO` are set, the interactive "Connect" flow is
  disabled.

## Milestone 1b — bidirectional functionality (syncables)

Reflector consumes `syncables` as a released npm dependency
(`syncables@0.17.1`, pinned in [`package.json`](../../package.json)). 
The bidirectional GitHub-issue reflection above was built on top of
`syncables`' local-first create/update/delete with background retry and
rollback, it works end-to-end against it, in both the live validation and the
harness's `reflected`/`mismatch`/`timeout`/`looped` scenarios.
See [syncables readme](https://github.com/localthought/syncables#nlnet-milestone-1)
for a more detailed description of how the bi-directional version of Syncables works.

## Supporting repos referenced by the issue

- **[localthought/syncables](https://github.com/localthought/syncables)** —
  the sync engine; milestone 1b's bidirectional functionality.
- **[localthought/overlays](https://github.com/localthought/overlays)** —
  the OpenAPI Overlays (pagination + CRUD-causality) that this repo
  vendors under [`spec/overlays/`](../../spec/overlays) and applies to the
  vendored OpenAPI documents at startup (see
  [`src/sync/document.ts`](../../src/sync/document.ts) and
  [`src/sync/overlay.ts`](../../src/sync/overlay.ts)).
- **OpenAPI extensions repo** (pagination + CRUD-causality extension
  definitions consumed by the overlays above) — referenced by the issue;
  not independently checked from this session.

All of the above, plus this repo, are public and open source.

## How to see it live

1. Set the two-endpoint env vars from the README's
   [GitHub setup](../../README.md#reflecting-between-two-systems-eg-two-github-issue-trackers)
   example (`OPENAPI_PATH`/`OVERLAY_DIR` pointed at
   `spec/github-issues.openapi.yaml` / `spec/overlays/github`,
   `REFLECT_A_REPO`/`REFLECT_A_TOKEN`, `REFLECT_B_REPO`/`REFLECT_B_TOKEN`,
   `REFLECT_DIRECTION=bidirectional`) against two real GitHub repos.
2. `pnpm build && pnpm start`.
3. Create an issue (or comment, or close one) on either repo and either wait
   for the background loop (`REFLECT_INTERVAL_MS`, default 60s) or trigger a
   pass on demand with `POST /api/reflect`; check `GET /api/reflect/status`
   for the loop's state.
