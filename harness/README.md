# Reflector reflection harness

A runnable test harness for the **single A→B calendar case**: drive a change
into one platform, wait for a Reflector instance to reflect it onto another,
and check that the reflection is correct — with the actor that makes changes,
the actor under test, and the observer kept strictly separate.

Everything here is thin custom code over the [`syncables`](https://github.com/localthought/syncables)
client (the same engine the app uses). It does **not** use the app's
`SyncEngine`; the driver and reviewer only touch the raw client primitive, so
they read and write without doing any reflecting of their own.

## Roles

| Role | File | What it does |
| --- | --- | --- |
| **Driver** | `roles.ts` | Writes run-tagged events onto the source platform and waits for them to actually land. Never reflects. |
| **System under test** | `roles.ts` (`StubReflector`) | Reads the source and writes mapped copies to the target — a stand-in for a real Reflector deployment. |
| **Reviewer** | `roles.ts` | Reads the target through fresh `syncables` clients and polls until the reflection appears. Independent observer. |
| **Oracle** | `scenario.ts` (`compareReflection`) | Decides "correct", independently of the reflector's own mapping. |
| **Orchestrator** | `scenario.ts` (`runReflectionScenario`) | `drive → kick → poll → judge → cleanup`, all in one process. |

Driver + reviewer live in the same process, so a test starts and finishes in
one place. Isolation comes from **separate storage and separate platform
`fetch`** per role, not from the process boundary — each role gets its own
in-memory copy, and the reviewer re-`sync()`s every poll so it never trusts
cached state.

## The two seams to replace for a live run

This harness is fully in-memory. To point it at real systems, replace:

1. **`FakePlatform`** (`fake-platform.ts`) — the in-memory stand-in for a
   remote system of record. Swap it for a `fetch` bound to the platform's real
   base URL + credentials. Give each role its own account where the platform
   allows, so the reviewer is a genuinely independent observer and the SUT can
   tell driver-origin changes apart.
2. **`StubReflector.reflectNow()`** (`roles.ts`) — currently reflects inline
   with a pluggable mapping. Swap it for a trigger to the real SUT's
   "reflect now" endpoint (a deterministic kick beats waiting for the SUT's
   natural interval).

## Outcomes the loop distinguishes

- `reflected` — every driven record appears on the target, correct on the
  compared fields.
- `mismatch` — the reflected records are present but wrong (e.g. a dropped
  field). The oracle is independent of the reflector, so a wrong mapping is
  caught, not rubber-stamped.
- `timeout` — the expected records did not appear within the poll window
  (distinct from appearing-but-wrong).

## Running

```sh
pnpm install
pnpm test:harness     # runs harness/reflection.test.ts
```

`pnpm test` (the unit suite) deliberately does **not** include this — keep the
fast deterministic units as the primary gate and run this integration-style
harness on demand / pre-release, since a live version talks to third-party
APIs and is slower and flakier by nature.

## Known limitations of the stub

- The stub reflector filters by the run marker; a real Reflector reflects by
  change detection. Loop/echo suppression (does a reflected write on B bounce
  back to A?) is therefore **not** exercised here — add it when the real SUT
  is wired in.
- The reviewer reads through `syncables`, so it shares the read path with the
  SUT. For a stronger oracle, read the target via its raw API instead — see the
  note on `Reviewer.readTagged`.
