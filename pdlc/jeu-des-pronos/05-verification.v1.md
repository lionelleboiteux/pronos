# jeu-des-pronos — Verify-gate evidence

> Gate 5 (verify) artifact. Integration/e2e, security, performance, and
> instrumentation proof against the green-gate build. One HIGH-severity
> security finding was found and fixed *within this gate* — see §1.

**Status:** verify gate | **Author:** Claude (Opus 5), with `bob-security-auditor`
and `bob-perf-analyst` (x2, see note in §2) and a general-purpose
integration/e2e agent | **Date:** 2026-08-05
**Result:** 118/118 tests passing (unchanged from green), `tsc --noEmit` clean,
one HIGH security finding fixed and re-verified, one proactive perf migration
added, success-metric instrumentation proven end-to-end against a real store.

---

## 1. Security — `bob-security-auditor`

### Finding (HIGH), found and fixed within this gate

The green-gate build (`04-green-evidence.v1.md` D-2) made `POST /v1/predictions`
trust the client-supplied `X-Forwarded-For` header as the rate-limit key,
reasoning that the process is "only ever reached through the Edge Function's
fronting proxy." The security auditor rejected that assumption: an Edge
Function's public URL is reachable directly, nothing in this repo verified
that Supabase's fronting infrastructure strips or overwrites a client-supplied
`X-Forwarded-For`, and public reports suggest the opposite is at least
plausible. Concretely: any caller reaching the deployed URL directly could set
a fresh `X-Forwarded-For` on every request and make each one look like a
distinct IP, defeating NFR-RATE-01 — the *only* DoS mitigation the
architecture doc names for the public, unauthenticated submit endpoint — and
since `submitPrediction.ts` emails a receipt to any attacker-supplied address
on acceptance, an unthrottled loop is also an email-bombing vector against
third parties.

Brought to the product owner (Lio, 2026-08-05) as a decision rather than fixed
silently. Options considered: (a) trust the real connection peer and solve the
resulting test-harness conflict separately, (b) research Supabase/Deno
Deploy's exact header semantics first, (c) ship with the gap documented.
**Decision: (a).**

### The fix

1. `src/api/server.ts` — `client_ip` now derives from `req.socket.remoteAddress`
   (the real TCP peer, which a requester cannot forge) instead of any header.
   The `firstForwardedFor` helper was removed entirely.
2. This reopens the original D-2 tension in a different shape: Schemathesis's
   own contract fuzzing sends many requests to `POST /v1/predictions` from one
   real OS process/socket, which the real limiter would now — correctly —
   throttle, failing the provider contract check on the fuzzer's own
   legitimate burst. Rather than spoof traffic shape again (which is what
   created the vulnerability), the submit rate limiter now exempts callers
   presenting the existing admin bearer secret:
   `rateLimiter: isAdmin(req, ctx) ? ALWAYS_ALLOW : ctx.rateLimiter`. This
   reuses the trust boundary already established and tested for `/admin/*`
   routes (NFR-AUTH-01) rather than introducing a new one — a caller without
   that secret gets zero exemption, and no real anonymous player is ever
   given it. The frozen provider contract test already sends this exact
   bearer token on every operation call (`ADMIN_TOKEN`, set once in
   `tests/contract/provider.schemathesis.test.ts`'s `beforeAll`), so this
   needed no change to any file under `tests/` — only to `src/api/server.ts`.
3. `tests/support/schemathesis.ts` / `tests/support/schemathesis_hooks.py` —
   the per-request simulated-IP hook from the original (now-superseded) D-2
   fix is removed; it's no longer meaningful once the server stops trusting
   the header it stamped. `git diff --stat -- tests/` for this gate:
   ```
    tests/support/schemathesis.ts       |  8 +-------
    tests/support/schemathesis_hooks.py | 24 ------------------------
    2 files changed, 1 insertion(+), 31 deletions(-)
   ```
   Net removal, no test assertion touched — same category of change as the
   two harness fixes already precedented at red and green.

### Verification (not just "tests pass")

- Two full-suite reruns after the fix: **118/118**, `tsc --noEmit` clean.
- `tests/contract/provider.schemathesis.test.ts` specifically re-run twice in
  isolation: 8/8 passing both times, including `CONTRACT-PROVIDER-submitPrediction`.
- **Manual, out-of-suite proof that the actual vulnerability is closed**: a
  throwaway script fired 15 `POST /v1/predictions` requests at a live server
  (real Testcontainers Postgres), each carrying a freshly rotated fake
  `X-Forwarded-For` and **no** admin bearer token — i.e. exactly the attack
  the finding describes. Result:
  ```
  statuses: 404,404,404,404,404,404,404,404,404,404,429,429,429,429,429
  PASS: attacker was rate-limited despite spoofing X-Forwarded-For
  ```
  (404s are the unrelated "no such game" validation response for a
  placeholder `game_id`; the point is the 11th request onward is `429`
  regardless of the forged header — the spoof no longer works.)
- A second, independent perf-analyst run (see §2) tested the same rate
  limiter against the committed pre-fix code by varying `X-Forwarded-For` and
  confirmed it looked "correctly" per-key from the *inside* — which is
  precisely why a header-trust bug is easy to miss from tests alone and
  needed the external, attacker's-eye-view check above.

### Other findings from the audit (not blocking, recorded for follow-up)

| Severity | Finding | Status |
|---|---|---|
| Medium | `/admin/*` auth is a static shared bearer secret compared with `===` (not timing-safe), not the Supabase Auth JWT the architecture doc describes. No demonstrated exploit path from this repo alone (no leak vector found); genuine architecture-vs-implementation mismatch. | Not fixed this gate — recommend either implementing real Supabase Auth JWT verification or updating the architecture doc to describe the actual mechanism, plus `crypto.timingSafeEqual`. |
| Info | Unhandled-exception path (`server.ts`) returns the raw internal error message to the client. No path found that reaches an unhandled exception (every input is `zod`-validated first, all SQL is parameterized) — defense-in-depth only. | Not fixed this gate — one-line fix when convenient (log real message server-side, generic message to client). |
| — | SQL injection review (`src/db/repository.ts`): every statement uses parameterized placeholders. | Clean. |
| — | RLS review (`db/migrations/0001_initial_schema.sql`): zero policies granted to `anon`/`authenticated`; only `service_role` can read/write. Matches NFR-RLS-01/02. | Clean. |
| — | Secret scanning (manual pattern scan across working tree + full git history — `gitleaks`/`semgrep` unavailable in this environment). | Clean. Recommend installing one in CI going forward. |
| — | Dependency audit: `npm audit --production` 0 vulnerabilities. Full `npm audit` (incl. devDependencies): 13 (2 critical, 2 high, 9 moderate), entirely in the `vitest`/`vite`/`esbuild` toolchain and Prism's dependency chain — none shipped in the Edge Function deployment bundle (`src/` only). | Info — routine `npm audit fix` on dev tooling recommended. |

**Verdict:** the one control the architecture doc names as its DoS mitigation
was defeated by the original fix, found and closed within this same gate, and
independently re-verified with an attacker's-eye-view test rather than trusting
the suite alone. Two smaller, non-blocking findings are recorded for follow-up.

---

## 2. Performance — `bob-perf-analyst` (two independent runs)

Two perf-analyst runs happened this gate: one I spawned deliberately; a second,
unrelated one turned out to be an orphaned agent from an interrupted verify
attempt earlier in this session (before a context compaction), whose
completion notification arrived mid-gate. Both measured independently and
reached the same conclusions, which is worth recording as corroboration
rather than discarding the second as noise.

**No formal latency/throughput NFR exists** (confirmed by both runs via grep
across `02-architecture.v1.md`, `traceability.md`, and the evidence files —
zero hits). The only quantified ceilings agreed at architecture time are the
Supabase free-tier meters and NFR-RATE-01 (10 req/min/IP, itself an
abuse-mitigation number, not a load number).

### Free-tier budget math (shown, not asserted)

- **Edge Function invocations** (500k/month budget): at 1x (3 leagues,
  ~10-20 players/league, weekly cadence) ≈ 46,500/month (9.3% of budget)
  under the most invocation-hungry reading of the cron cadence; at 10x
  (player count only) ≈ 72,200/month (14.4%). Comfortably clear at both.
- **DB storage** (500MB budget): measured by inserting 50k rows each into
  `predictions` and `telemetry_events` against the real production migration:
  265.3 bytes/row and 445.5 bytes/row respectively. Projected onto a
  38-gameweek season: ~17MB/season at 1x, ~165MB/season at 10x. Reaching
  500MB at 1x would take decades; at a sustained 10x it would take roughly
  three full seasons of unpurged history — worth naming as a future
  retention-policy question, not a current concern.

### Measured latency (against real Testcontainers Postgres, not empty tables)

Warm request latency at both 1x (150 prediction rows in the target gameweek)
and 10x (1,950 rows): single-digit-to-low-teens milliseconds, p95 under 20ms
at both scales, for both `GET /v1/leagues/{id}/current` and
`POST /v1/predictions`. A second, independently-seeded run (different data
volume, different host load conditions) landed in the same range (sub-5ms to
low-teens ms across four endpoints). No plausible network/pooler overhead on
real Supabase erases that margin at 10-20 concurrent-ish users.

### Algorithmic finding, acted on

Both runs independently flagged the same gap via `EXPLAIN`: `games` and
`predictions` are filtered by `gameweek_id` on the hottest read paths
(`src/db/repository.ts` `getLeagueCurrentState`), and `league_gameweek_standings`
/ `overall_standings` are filtered by columns not leading their only index —
all four force a sequential/non-seeking scan. Not currently measurable (seeded
tables only ever contained one gameweek's worth of rows, so scan cost was
indistinguishable from a seek), but the failure mode is well understood: scan
cost grows with *total accumulated rows*, not "this gameweek's rows," and this
schema has no retention/purge policy. **Fixed proactively**, since the fix is
cheap and purely additive (ADR-0003 expand-only discipline):
`db/migrations/0002_add_gameweek_lookup_indexes.sql` adds the four missing
leading-column indexes. Full suite re-run clean after applying it (118/118).

Secondary, explicitly-not-acted-on finding from both runs: `repository.ts`'s
`rescore()` and `insertTelemetryEvents()` loop one `await pool.query(...)` per
row rather than batching. This runs only on the admin/cron path (not
user-facing) and isn't worth the complexity at this project's scale — left
alone, consistent with both agents' own recommendation.

### Verdict

Both runs concluded the absence of a formal latency NFR is a reasonable call
at this project's scale (10-20 players/week, single admin, no concurrency
pressure), not a gap to send back to the product owner — the free-tier meters
function as the real, enforceable budget, and this build sits at 9-15% of the
invocation budget with a multi-year storage margin. Agreed and adopted.

---

## 3. Integration / contract — both sides, deeper than green-gate depth

An integration/e2e verification agent independently re-ran the full suite and
extended contract-fuzzing depth beyond the frozen suite's default. It got
caught mid-run in a multi-agent coordination issue — it observed my concurrent
security fix (§1) landing in the working tree while it was running and
(reasonably, given it has no visibility into this conversation) suspected an
unauthorized change, spent significant time cross-checking with its sibling
agents before I could clarify the file changes were mine and intentional.
Because of that, it never produced one clean final report; its substantive
findings are folded in below from what it did establish before and after the
clarification, rather than from a single structured summary:

- **Setup**: Node v26.5.1 (meets the ≥22.18 requirement from D-1), Docker
  available, `.venv-contract` provisioned.
- **Full suite**: `tsc --noEmit` clean; `npm test` 118/118 across all runs it
  performed, both before and after my mid-gate fix.
- **`git diff --stat -- tests/`**: confirmed empty of assertion changes at
  every check (only the harness files noted in §1).
- **Deeper contract fuzzing** (`max-examples=50`, 10x the frozen suite's
  depth-5, against every operation in `contracts/openapi.yaml`, booted the
  same way as `tests/contract/provider.schemathesis.test.ts`): **clean, no
  new failures** versus the frozen suite's depth.
- **Consumer contract coverage**: `tests/contract/consumer.prism.test.ts`
  passes, including `CONTRACT-COVERAGE`, which asserts every operation
  declared in `openapi.yaml` has a consumer test — contract coverage is
  complete on both sides (consumer test exists **and** provider fuzz-passes)
  for every operation.
- **E2E journeys** (`tests/e2e/gameweekJourney.test.ts`): both pass against a
  real Postgres and the real HTTP API. E2E-01 chains submit → lock (via DB
  update simulating kickoff) → `rescore` admin action → real scoring run →
  standings read, and asserts the resulting classement. E2E-02 chains a
  post-kickoff submission → `409 MATCH_LOCKED` → confirms exactly
  `prediction_rejected_late` (not `prediction_submitted`) landed in the real
  `telemetry_events` table.
- It left no stray Docker containers or processes running after its final
  check (confirmed independently — `docker ps` clean of `postgres:16-alpine`
  containers at the time this artifact was written).

---

## 4. Instrumentation proof — Pam's metric, computed by hand from the real store

Per `bob-instrumentation`: exercised the feature against the live API and a
real Postgres (Testcontainers, production migrations applied — not a mock),
then read `telemetry_events` back and computed the registered metric from
those rows. Script used (throwaway, not committed, deleted after the run):
booted `startServer()` + `startTestDatabase()` the same way the frozen e2e
suite does.

### What was exercised

| Action | HTTP result |
|---|---|
| On-time submission (future-kickoff league) | `200` |
| Late submission (past-kickoff league) | `409 MATCH_LOCKED` |
| Admin override `open` (duration 3min) | `200` |
| Admin override `rescore` (duration 1min) | `200` |
| Admin override `rescore` (duration 1min) | `200` |
| Admin override `rescore` (duration 2min) | `200` |
| Replay of the first `rescore`'s Idempotency-Key with a different duration (999min) | `200`, but event count unchanged (9 → 9) |

The idempotency replay is a direct proof of NFR-IDEM-02's purpose: a retried
admin action does **not** insert a second `admin_manual_intervention` row,
so the metric this endpoint exists to protect cannot be inflated by a retry.

### Rows retrieved from the real `telemetry_events` store

9 rows landed: 1 `prediction_submitted`, 1 `prediction_rejected_late`, 4
`admin_manual_intervention` (one per override above), and **3
`scoring_run_completed`** — a finding in itself: each `rescore` admin action
genuinely runs `runScoring()` internally (`src/db/repository.ts`'s `rescore`
function) and emits `scoring_run_completed` as a real side effect, not just
`admin_manual_intervention`. This wasn't obvious from reading the handler
code alone (`adminOverride.ts` only ever builds the one event it names) —
worth recording since it means this event type is exercised end-to-end too.

Sample rows (full set captured in the session log):
```json
{"event_type":"admin_manual_intervention","league_id":"e57e...","gameweek_id":"c072...","game_id":null,"occurred_at":"2026-08-05T10:05:29.673Z","payload":{"type":"rescore","league":"e57e...","gameweek":15,"timestamp":"2026-08-05T10:05:29.673Z","duration_minutes_estimate":1}}
{"event_type":"scoring_run_completed","league_id":"e57e...","gameweek_id":"c072...","game_id":null,"occurred_at":"2026-08-05T10:05:29.676Z","payload":{"league":"e57e...","run_at":"2026-08-05T10:05:29.676Z","gameweek":"c072...","players_scored_count":0}}
```

### The metric, computed by hand

```sql
select date_trunc('week', occurred_at) as week_start,
       sum((payload->>'duration_minutes_estimate')::numeric) as total_minutes,
       count(*) as intervention_count
  from telemetry_events
 where event_type = 'admin_manual_intervention'
 group by week_start
 order by week_start;
```
Result: **week of 2026-08-03: 7 minutes across 4 interventions.**

This is a synthetic dataset built to prove computability, not a real usage
number — per `02-architecture.v1.md` §6, the actual baseline is unknown and
can only be measured once these events run in production before the old
spreadsheet process is retired. What this proves is narrower and load-bearing
in its own right: **the query that will answer "weekly manual admin time" is
correct, runs against the real store, and an idempotent retry cannot corrupt
it.** That is what `bob-instrumentation` requires at this gate.

### Gap found: 4 of the 8 required event types have no wired production entry point

Grepping `src/api/server.ts` and `src/db/repository.ts` for the domain
functions behind the remaining four required events confirms:

| Event type | Wired to a real trigger in this repo? |
|---|---|
| `prediction_submitted` | Yes — `POST /v1/predictions` |
| `prediction_rejected_late` | Yes — `POST /v1/predictions` |
| `admin_manual_intervention` | Yes — `POST /v1/admin/gameweeks/{id}/override` |
| `scoring_run_completed` | Yes — as a side effect of the `rescore` admin action |
| `match_locked` | **No** |
| `gameweek_opened` | **No** |
| `gameweek_closed` | **No** |
| `duplicate_flagged` | **No** |

`src/domain/gameweekTransition.ts`'s `tick()` and
`src/domain/duplicateDetection.ts`'s `runWeeklyDuplicateScan()` are pure,
fully-tested domain functions (unit + `tests/telemetry/emission.test.ts` with
a fake sink, plus direct-INSERT proof at the schema layer in
`tests/db/schema.test.ts`) — but nothing in `src/` calls them. The
architecture's chosen scheduling mechanism (`pg_cron`, ADR-0001) needs
*something* to invoke, and that Edge Function entry point doesn't exist yet
in this codebase; it's out of the module map this green gate built
(`04-green-evidence.v1.md` §4 lists only `submitPrediction.ts`,
`getCurrentGameweek.ts`, `adminOverride.ts` as HTTP handlers).

**This does not block this gate**: the one metric actually registered in
`state.json` (`weekly manual admin time`) is fully provable end-to-end today,
as shown above, and these four events' *logic* is already correct and tested.
But it is a real, concrete gap for whoever wires the pipeline/dashboard gates
next — flagging it now, per `bob-instrumentation`'s own guidance that
instrumentation gaps are cheapest to catch before release, not after.

---

## 5. Files changed this gate

| Path | Change |
|---|---|
| `src/api/server.ts` | Security fix: `client_ip` now the real socket peer, not `X-Forwarded-For`; submit rate limiter exempts admin-bearer callers only. |
| `tests/support/schemathesis.ts` | Harness: removed the now-unnecessary `SCHEMATHESIS_HOOKS` wiring. |
| `tests/support/schemathesis_hooks.py` | Deleted — the IP-spoofing hook it provided is no longer used or wanted. |
| `db/migrations/0002_add_gameweek_lookup_indexes.sql` | New, additive migration: 4 missing leading-column indexes (perf finding, §2). |
| `pdlc/jeu-des-pronos/05-verification.v1.md` | This artifact. |

`tests/` assertion files: untouched (see `git diff --stat` in §1).
`pdlc/jeu-des-pronos/04-green-evidence.v1.md`: untouched — Bob's own
`bob check green` reports gate artifacts are "versioned, not overwritten," so
D-2's original (now-superseded) writeup stands as the historical record of
what passed green; this artifact is where the correction and the real fix
live.

## 6. Overall verdict

**Verify gate passes.** One HIGH security finding was found and closed within
this same gate, with an attacker's-eye-view re-verification (not just a green
test suite) proving the fix holds. Performance has no blocking issues and one
proactive improvement was made. Contract coverage is complete on both sides,
confirmed at both default and 10x fuzz depth. The one registered success
metric is provably computable end-to-end against the real event store, with
its idempotency guarantee also proven directly. Two non-blocking security
findings (Medium: admin auth mechanism vs. documented design; Info: error
message leakage) and one instrumentation-completeness gap (4 of 8 event types
have no production trigger yet) are recorded above for the next gates.
