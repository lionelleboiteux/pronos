# jeu-des-pronos — Pipeline-gate evidence

> Gate: pipeline (John). Deploy mechanism, immutable release tagging, and a
> real, rehearsed, stopwatch-timed rollback against the live project.

**Status:** pipeline gate | **Author:** Claude (Sonnet 5) | **Date:** 2026-08-07
**Result:** deploy workflow live and green in GitHub Actions; rollback job
exercised for real against the hosted Supabase project and independently
verified from the outside (not just trusted from the job's exit code).
Measured rollback: **27s job execution / 44s end-to-end from trigger**.

---

## 0. What this gate found before any of the above could happen

The green gate shipped `src/api/server.ts` as a Node.js `http.createServer`
process, spawned via `node:child_process`. The architecture
(`02-architecture.v1.md`, ADR-0001) commits to Supabase Edge Functions,
which run on a Deno-compatible runtime and do not support arbitrary Node
HTTP servers or child processes at all — confirmed via Supabase's own docs,
not assumed. This is a real architecture-vs-implementation mismatch that
had gone undetected through red, green, verify, polish, and ship. The user
chose to port rather than reconsider the platform choice. That port is the
majority of this gate's work and is described in commit `bd5656b`:

- `src/api/router.ts` (new): the entire routing/validation table, with zero
  Node or Deno types in it. Both entrypoints share this one implementation.
- `src/api/server.ts`: slimmed to the Node HTTP transport adapter only
  (still used by `tests/` and the Schemathesis provider-contract suite).
- `src/db/repository.ts`: decoupled from the Node-only `pg` package via a
  structural `QueryExecutor` interface.
- `supabase/functions/api/index.ts` (new): the real `Deno.serve()`
  entrypoint, using Supabase's documented `deno-postgres` driver.

Verified before proceeding: 118/118 Node tests still passing, `tsc --noEmit`
clean, and the Deno port independently exercised end-to-end against a real
local Postgres (`supabase start`: Postgres + Kong + edge-runtime) — all 8
endpoints, including the write path, admin auth boundary, and rate
limiting. `postgres.js` (`npm:postgres`) could not resolve Docker-internal
hostnames inside the edge-runtime sandbox (`getaddrinfo ENOTFOUND`); this
is a real, reproducible incompatibility, not a config mistake — switching
to Supabase's own documented `deno-postgres` driver resolved it immediately.

## 1. Deploy mechanism

**Target:** the live hosted Supabase project `dmytkubjxwwwkroutvdu`
(confirmed with the user before touching it — this was empty/unconfigured
until this gate).

**Workflow:** [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml)

- `on: push: tags: 'v*.*.*'` — deploy job: full test suite as a pre-deploy
  gate (`npm test`, 118 tests), `tsc --noEmit`, then `supabase db push`
  (expand-only migrations) and `supabase functions deploy api`.
- `on: workflow_dispatch` with a `rollback_to_tag` input — rollback job:
  checks out the given tag and redeploys **only** the Edge Function code.
  Deliberately does not run `db push` — see §3.
- Auth: a single `SUPABASE_ACCESS_TOKEN` repo secret (Management API
  personal access token). `SUPABASE_PROJECT_REF` is a plain env var, not a
  secret — it's already public in the project's dashboard/API URL.
- CLI version is pinned (`2.111.0`), not `latest` — see the real bug this
  caught, §4.

**Immutable artifacts:** every deploy is triggered by an annotated, pushed
git tag (`v1.0.0`, `v1.0.1`, `v1.0.2`), each with a corresponding
`gh release create`. Per `02-architecture.v1.md` §6, deploys and rollbacks
always reference a specific tag — never a moving branch — so "what's live"
is always traceable to an exact, reviewable commit.

## 2. Real deploys performed this gate

| Tag | What changed | Deployed via | Live? |
|---|---|---|---|
| `v1.0.0` | First deployable Deno port | manual CLI (CI didn't exist yet) | Was live; superseded |
| `v1.0.1` | Adds `x-deployment-id` response header | CI (`push: tags`) — **failed**, see §4 | Never went live |
| `v1.0.2` | Same app code as v1.0.1 + fixes the CI bug | CI (`push: tags`) — succeeded | **Live now** |

`x-deployment-id` (sourced from Supabase's injected `DENO_DEPLOYMENT_ID`)
was added specifically so a deploy or rollback could be verified from the
outside — by curling the live endpoint and checking which code actually
answered — rather than trusted from a green CI job alone. This mattered:
see §4 and §5, both of which were only caught/confirmed because of it.

## 3. Rollback plan and why it's code-only

Per the architecture's rollback plan (`02-architecture.v1.md` §6) and
ADR-0003 (every migration is expand-only — no schema rollbacks are
possible on Supabase Free, which has no PITR):

- **Edge Function code**: fully reversible. `git checkout <tag>` +
  `supabase functions deploy` restores exactly the code that was running
  at that tag. This is what `deploy.yml`'s `rollback` job automates.
- **Database schema**: not rolled back, by design. A destructive schema
  change is never shipped in the same release as the code that needs it —
  rollback there means *not deploying* code that depends on the new
  columns, not reversing the migration. A manual `pg_dump` before any
  destructive change remains the only DB recovery path, per ADR-0003; no
  destructive migration has been written yet, so this hasn't been
  exercised.

This is why the rollback job has no `db push` step at all — it would be
actively wrong to add one.

## 4. Real bug the rehearsal caught

`v1.0.1`'s CI deploy failed at `supabase link`:

```
failed to get api keys: SchemaError(Expected a string matching the RegExp
^...T(?:...Z)$ at [2]["inserted_at"])
```

The `supabase/setup-cli@v1` action's `version: latest` resolved to a CLI
build whose response-schema validator rejected a timestamp shape the live
Management API actually returns — a real CLI/API version-skew bug, not a
mistake in this repo's config. `2.111.0` (verified working locally against
this same project earlier in this gate) does not have this problem.
Fixed by pinning the version explicitly (commit `2a95b66`); shipped as
`v1.0.2`, which deployed clean in CI on the first try after the fix.

`v1.0.1`'s git tag and GitHub release stand as-is — it never went live, and
that's the honest record of what happened, not something to silently erase.

**This is exactly the value of rehearsing a pipeline before relying on it**:
this bug would otherwise have been discovered during a real incident, at
the worst possible time to be discovering CI plumbing problems.

## 5. Rollback rehearsal — measured

Sequence, all against the live project, all via the real CI workflow (not
simulated):

1. `v1.0.2` deployed clean via `push: tags` (§2). Confirmed live: GET
   `/v1/leagues` returned `x-deployment-id: ..._2`.
2. Triggered `gh workflow run deploy.yml -f rollback_to_tag=v1.0.0` at
   `2026-08-07T11:50:25Z`.
3. GitHub Actions job (`rollback`) completed in **27s** (job's own reported
   duration). Wall clock from trigger to observed completion (including
   Actions queueing/dispatch latency) was **44s**.
4. **Independently verified**, not just trusted from the job's green
   checkmark: GET `/v1/leagues` immediately after showed **no**
   `x-deployment-id` header at all — because `v1.0.0`'s code never had that
   header. This is unambiguous proof the rollback changed what code was
   actually running, not just that a command exited 0.
5. Rolled forward again to `v1.0.2` via the same rollback job
   (`rollback_to_tag=v1.0.2`) to leave the live project on the current
   release. Verified: `x-deployment-id` present again (a new deployment
   id, `..._4` — each redeploy gets a fresh id even redeploying the same
   tag, which is expected and fine).

**Rollback time: ~30–45 seconds**, dominated by `supabase functions deploy`
itself, not by anything in this repo's control. No database step is
involved (§3), so there is no migration-replay time to add.

## 6. Migration safety

Both existing migrations (`db/migrations/0001_initial_schema.sql`,
`0002_add_gameweek_lookup_indexes.sql`) were pushed to the live project via
`supabase db push` — both additive (initial schema; four new indexes), both
already covered by ADR-0003's expand-only discipline established at the
architecture gate. No destructive migration exists yet, so the "manual
`pg_dump` before an irreversible change" half of the DB recovery plan has
not been exercised — flagged here as a real gap, not silently assumed safe.

## 7. One-way doors found

- **`ADMIN_TOKEN` is a real, freshly-generated production secret**, set via
  `supabase secrets set` and never committed. It is now the only credential
  gating the four admin endpoints (`/v1/admin/...`) on the live project.
  Rotating it requires updating the Supabase secret and whoever/whatever
  calls the admin API out-of-band — there is no admin UI yet to do this
  from.
- **The Supabase personal access token used to authenticate this session's
  CLI was pasted directly into the chat transcript** by the user, at my
  request, because the automatic browser-OAuth login flow needs a TTY this
  environment doesn't have. It is now also stored as the
  `SUPABASE_ACCESS_TOKEN` GitHub Actions secret (not visible after being
  set, but it did pass through this conversation in plaintext once). Flagged
  to the user in-conversation; rotating it from the Supabase dashboard is a
  reasonable precaution and does not require any code change here.
- **The `x-forwarded-for`/`cf-connecting-ip` client-IP logic for rate
  limiting** (`supabase/functions/api/index.ts`) is my best judgment based
  on Supabase's and Cloudflare's documented proxy behavior, but has not
  been empirically confirmed against real traffic patterns on this project
  (no adversarial traffic has hit it yet). Until it is, treat rate-limit
  bypass via a forged header as an open risk on the hosted deployment,
  even though the equivalent Node-side bug (trusting a raw client header)
  was fixed and verified at the verify gate.
- **`v1.0.1` is a released tag that was never live.** This is intentional
  and documented (§4), but anyone reading release history without this
  document could reasonably assume it was deployed at some point. It wasn't.

## 8. Suite status

118/118 tests passing, `tsc --noEmit` clean — both locally (final check
before this document) and as the pre-deploy gate inside the CI workflow
itself, which is the run that actually gated the `v1.0.2` production
deploy.
