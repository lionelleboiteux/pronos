# jeu-des-pronos — Architecture and design

> Gate 2 artifact. Research and assessment only. No production code.

**Status:** architecture passed | **Author:** Claude (Sonnet 5), with Lionel Le Boiteux | **Date:** 2026-08-03

## 1. Situation

- **Type:** greenfield. The repo's initial commit contains only unrelated scaffolding (an orphaned `Frontend` submodule reference and a one-route Express "hello world" stub) — nothing resembling the pronos domain. Today's real system is 9 spreadsheets and per-league Make.com scenarios, outside this repo entirely.
- **Surfaces:** a static player-facing web form + a small admin view, a backend API, a database, and scheduled jobs. No mobile, no desktop, no CLI (mini-leagues, native app, and the wider Wix migration are explicitly out of scope).
- **Modules touched:** none — everything is new.
- **Estimated new code:** the full stack (schema, API/Edge Functions, scoring/duplicate/lock logic, 3 fixture adapters + fallback, frontend, telemetry). **Modified:** none.
- **Refactoring needed first:** none — there is nothing to make safe, because there is nothing there yet.
- **A user-supplied asset changes the shape of this gate**: Lio had already designed a Postgres schema for Supabase (`context/supabase_score_prediction_schema.sql`) covering leagues/seasons/teams/players/gameweeks/games/predictions/scores/standings before this gate started. That schema is the starting point for Option A below, not a fourth independent option — it's real prior work, adopted with two fixes and four additions (§5, `contracts/db-schema.sql`).

### Testability assessment

| Unit | Currently needs | Proposed seam |
|---|---|---|
| Scoring calculator (5/3/2/0, blank/double-gameweek summation) | nothing — greenfield | pure function over `(prediction, actual scores)`, no DB/network; the schema's `prediction_scores.scoring_breakdown jsonb` gives it somewhere to land |
| Lock/reject check (AC-01, AC-02) | nothing — greenfield | pure function over `(now, game.starts_at)`; called both by the submit endpoint (authoritative) and the frontend (cosmetic grey-out only) so the two can never disagree on which one is authoritative |
| Gameweek transition / scoring-run tick | nothing — greenfield | inject `now` into the tick function rather than calling the clock directly, so pg_cron-triggered logic can be exercised with synthetic timestamps in tests, not real wall-clock waits |
| Fixture/results ingestion (3 leagues + fallback) | a real network + a real, unstable external site | adapter interface (`fetch(league_config) -> normalized matches[]`) tested against recorded HTML/JSON fixtures per adapter; the live site's actual behaviour is untestable in CI by construction and is instead covered by a production health-check alert, not a test |
| Duplicate-pseudo similarity scan | nothing — greenfield | pure function over a list of pseudos for a gameweek, no DB needed to unit-test the string-distance logic itself |

## 2. Options considered

Three candidate architectures were explored in depth (full reports available on request); this section summarizes the findings that drove the recommendation, then folds in the schema Lio had already built.

### Option A — Cloudflare Workers + D1 + Cron Triggers + Pages
**Shape:** Workers API, D1 (SQLite) as the datastore, Cron Triggers for scheduling, Pages for the static frontend.
**Run cost:** effectively £0 at 1x and 10x — every Cloudflare meter has 10-100x headroom at this traffic.
**The real cliff:** Cron Triggers are capped at 5/account regardless of plan. Solvable by looping one shared tick job over a league-config table instead of one trigger per league per job — a design discipline, not a cost.
**Rollback:** code (Workers/Pages) is fast, versioned, near-instant. D1's only free-tier recovery mechanism is Time Travel — a **whole-database** point-in-time restore (7 days free), not a per-record undo; recovering from a bad migration after real predictions have landed risks losing legitimate submissions unless reconciled by hand.
**Closes the door on:** Cloudflare-specific SQL dialect and `workerd` runtime constraints (128MB memory, 10ms CPU/request on free tier) — migrating off Cloudflare later means rewriting the data layer and the scheduling model, not just redeploying.

### Option B — Managed long-running service + Postgres (Render + Neon/Supabase + external cron)
**Shape, as literally scoped, does not survive verification:** Fly.io has no meaningful free tier anymore (discontinued 2024); Render's free tier has no free cron/background-worker product either — only a free *web service* that sleeps after 15 minutes idle. The workable version bolts a GitHub Actions scheduled workflow onto that sleeping container as an external wake-up mechanism.
**The real cliff:** not cost — **scheduling precision**. GitHub Actions cron has documented 10-30 minute delays at peak times, stacked with Render's 30-60s cold start. Realistic worst-case lag between "gameweek's last match kicks off" and "gameweek visibly closes" is tens of minutes, directly touching AC-06/AC-07 (the exact behaviour the project exists to make reliable).
**Failure isolation:** one shared process and one shared DB for all three leagues means a bad query or quota trip is a simultaneous outage across all three — a regression versus today's siloed-but-independent spreadsheets, and in tension with AC-07's per-league independence.
**Structural weakness, in the option's own words:** it spends its build budget reconciling a clock-driven, bursty workload against free compute that's built for request-driven traffic, rather than getting scheduling for free the way an architecture built around scheduled execution would.

### Option C — Airtable as datastore + thin serverless API
**Disqualifying finding:** Airtable's Free plan record cap (1,000/base) is exhausted by **match rows alone** — a season across 3 leagues is ~1,000-1,050 match rows before a single prediction exists. This is a **1x-load cliff within the first season**, not a 10x cliff. The monthly API-call cap (1,000/workspace) is plausibly exhausted within 1-2 weeks of normal form usage. The workable version needs Airtable Team (~$20/month minimum), directly contradicting the confirmed £0 budget assumption.
**Structural conflict, not just cost:** the option's own stated appeal — Lio's comfort editing the grid directly, closest to today's spreadsheet habits — is in direct tension with the project's audit requirement. A direct grid edit bypasses the API layer entirely and emits no `admin_manual_intervention` telemetry, meaning the exact metric the project exists to prove (weekly admin time) could be silently invisible to itself, from the person most likely to reach for the familiar tool under deadline pressure.
**Also lacks native transactions/uniqueness**, so the same correctness problems (idempotent scoring, overwrite-not-duplicate) must be hand-built anyway — the datastore's "spreadsheet comfort" buys nothing back in exchange for its constraints.

### Option A (revised) — Supabase Postgres + Edge Functions + pg_cron, adopted
**Shape:** the schema Lio built (`contracts/db-schema.sql`, extending `context/supabase_score_prediction_schema.sql`), Supabase Edge Functions (Deno) as the only write path, `pg_cron` + `pg_net` running inside Postgres itself for scheduling (match-lock/gameweek-transition ticks, the morning-after scoring run, per-league fixture ingestion), a static frontend (Cloudflare Pages) calling the API only.
**Why this beats the original Option A:** it keeps Option A's £0-at-10x headroom while removing Option B's scheduling-precision failure mode entirely — the scheduler runs next to the data, not on a separate container that has to wake up, so pg_cron's minute-level granularity replaces GitHub Actions' 10-30 minute drift. It avoids Option C's record/API caps (Postgres row counts aren't metered the same way) and its audit-integrity conflict (all writes go through Edge Functions, which is where telemetry is emitted; there is no comparable "edit the grid directly" bypass in this shape once RLS blocks public writes — see §7).
**Verified free-tier facts that made this decision (2026):** `pg_cron` ships enabled by default on Supabase's Free plan; 500,000 Edge Function invocations/month free; unlimited PostgREST API requests; 500MB DB storage, 500MB shared RAM; **no daily backups and no point-in-time recovery on Free** (PITR is a $100/month Pro+ add-on) — this is the one real gap, addressed in §6.
**Build cost:** everything is new. Roughly: schema is already ~80% done (Lio's design, plus this gate's 5 additions); Edge Functions for submit/read/admin endpoints; 3 fixture/results adapters + fallback source (the highest-risk, least Supabase-specific item — this exists under any option); scoring/lock/duplicate logic as pure functions; pg_cron job definitions; frontend form + admin view; telemetry wiring.
**Failure modes:** fixture source breaks (per-league try/catch required so one league's bad scrape can't starve the others — must be built deliberately, not free); a bad Edge Function deploy affects only that function (Edge Functions deploy independently, unlike Option B's single shared process); a runaway query against the 500MB/shared-RAM free instance risks the same kind of correlated failure Option B had, but is far less likely at this data volume than it was for Option B's always-on web service under general request traffic.
**Rollback:** see §6.
**Testability:** scoring/lock/duplicate logic as pure functions (fast, no DB); Edge Functions testable against a local Supabase stack (`supabase start`) with synthetic `now`; the 3 real scraping adapters are the one part of any option that can't be verified against the live source in CI — covered by recorded fixtures plus a production health-check, not by tests.
**What this closes the door on:** everything now depends on Supabase specifically for both data and scheduling (pg_cron/pg_net are Postgres extensions, portable in principle, but the free-tier operational model — shared compute, no backups — is Supabase's own). Migrating away later means re-hosting Postgres and rebuilding the scheduling harness, not just redeploying.

## 3. Recommendation

**Supabase Postgres + Edge Functions + pg_cron/pg_net, on Lio's existing schema (extended)** — it is the only option whose free tier survives real usage (not just 10x, but 1x, unlike Option C) without trading away an acceptance criterion (unlike Option B's scheduling-precision risk to AC-06/07), and it builds directly on real prior work rather than discarding it.

**User decision:** accepted (Supabase Edge Functions as the sole API layer, no separate Cloudflare Workers layer; `players.email` made nullable) on 2026-08-03.

## 4. Cost and free-tier fit

| Provider | Component | Free-tier limit | Expected use (3 leagues, ~10-20 players, weekly) | Use at 10x | First cliff |
|---|---|---|---|---|---|
| Supabase | Postgres storage | 500MB | a season's rows (matches + predictions + standings) is low tens of thousands of rows, well under 500MB | still well under 500MB — this workload is row-count-light, not storage-heavy | not storage; see below |
| Supabase | Shared compute/RAM | 500MB shared instance | trivial at this query volume | a runaway/unindexed query (e.g. an N+1 in double-gameweek scoring) is the realistic way to feel this, not raw traffic | a bad query, not player count |
| Supabase | Edge Function invocations | 500,000/month | a few thousand/month (form reads + submits + scheduled ticks) | tens of thousands/month — still far under the cap | none identified at 10x |
| Supabase | Project inactivity pause | pauses after 7 days with zero DB requests | pg_cron's own scheduled activity prevents this from ever triggering | same | n/a while pg_cron runs |
| Supabase | Backups / PITR | **none on Free** — Pro+ only, PITR is a $100/mo add-on | n/a | n/a | **this is the actual first cliff** — not a usage limit but a missing safety net; addressed in §6, not by upgrading a meter |
| Cloudflare Pages | Static frontend hosting | 500 builds/month, unlimited bandwidth/requests | a handful of builds/week during active development | still trivial | none at this scale |
| (per-league fixture source) | official-site scrape, no published rate limit; fallback API e.g. football-data.org | fallback ~10 req/min, restricted competition list | low request volume (a few polls/day/league) | still low — polling frequency doesn't need to scale with player count | an anti-bot block on the scraped site, unrelated to this project's own traffic |

**What happens at the cliff:** a Postgres storage/compute limit on Supabase's free tier throttles/degrades performance rather than an immediate hard stop; the *backup* gap isn't a metered cliff at all — it's simply "if a bad migration or bad `admin` action corrupts data, there is nothing free to restore from except what §6 makes the team build."

## 5. API contracts

| Interface | Type | File | Consumer test | Provider test |
|---|---|---|---|---|
| Player + admin API (frontend ↔ Edge Functions) | OpenAPI 3.1 | `contracts/openapi.yaml` | Prism mock | Schemathesis |
| Datastore (Edge Functions ↔ Postgres) | SQL DDL | `contracts/db-schema.sql` | — (same trust boundary, not a process contract) | migration tests at red |

Versioning strategy: URL-prefixed (`/v1/...`), distinct from Supabase's own `/functions/v1/` platform segment (called out explicitly in the OpenAPI `info` block). Additive changes stay in `/v1`; breaking changes go to a new `/v2` prefix deployed alongside `/v1` until migrated.

**Endpoints (9 operations, all under `/v1`):** `GET /leagues` (public), `GET /leagues/{id}/current` (public — matches, live-computed `is_locked`, caller's own pick via optional `pseudo`), `POST /predictions` (public, upsert), `GET /leagues/{id}/gameweeks/{id}/standings` and `.../standings/overall` (public, paginated), `GET /admin/duplicate-flags` and `PATCH /admin/duplicate-flags/{id}` (admin), `POST /admin/gameweeks/{id}/override` (admin). No "create league" endpoint exists — per AC-13, a 4th league is added via `leagues.config` directly, deliberately outside the API surface.

**Error envelope:** `{"error": {"code", "message", "details", "request_id"}}` with a closed `code` enum (`VALIDATION_FAILED`, `MATCH_LOCKED`, `NOT_FOUND`, `UNAUTHORIZED`, `CONFLICT`, `INTERNAL_ERROR`). `MATCH_LOCKED` (409) is deliberately distinct from `VALIDATION_FAILED` (400) so the frontend can render AC-01's "match already started" message specifically, even from a stale page.

**Idempotency:** `POST /predictions` is idempotent via the DB's `unique(player_id, game_id)` upsert (AC-11) — no key needed for the row itself; an optional `Idempotency-Key` additionally dedupes the email-receipt side effect. `POST /admin/.../override` requires `Idempotency-Key` since its side effects (telemetry insert, rescoring) aren't safe to silently repeat.

**Auth:** `security: []` on every player endpoint; Supabase Auth bearer JWT required on every `/admin/*` operation.

**Lint result:** clean (`@redocly/cli lint` reports valid, one reviewed-and-accepted warning on `GET /leagues` for having no non-default 4xx — it has no auth or parameters and no realistic per-request failure mode beyond the shared `default` response).

## 6. Rollback plan

- **Mechanism:**
  - **Frontend (Cloudflare Pages):** Tier 1 — every deploy retained, promote a previous one from the dashboard/CLI. Effectively instant.
  - **Edge Functions:** Tier 0 — no platform-native rollback exists (confirmed: dashboard editing has no versioning). Functions are deployed from git via `supabase functions deploy <name>`; rollback is `git checkout <previous-tag>` then redeploy. Time to roll back: one CLI deploy cycle — to be **measured**, not estimated, at the pipeline gate.
  - **Database (Postgres):** no platform rollback exists on Free — this is the gap that matters most. Compensating control, since none is provided: **a scheduled `supabase db dump` (or `pg_dump`) taken before every migration is applied**, stored outside Supabase (e.g. committed to a private location or pushed to object storage), so a bad migration can be manually restored from a known-good dump. This is a deliberate build task, not a platform feature — it must be on the plan, not assumed.
- **Detected by:** the required telemetry itself, since Supabase gives no "job didn't run" alert. Concrete signal: no `scoring_run_completed` event recorded for a gameweek by noon the day after its last match kicked off (that gameweek's `ends_at`/last game's `starts_at`) → treat as a missed run and alert. Same pattern for `gameweek_closed` not appearing within, say, 15 minutes of the last known match's kickoff, given pg_cron's minute-level granularity.
- **Triggered by:** Lio, manually — sole admin/operator, no on-call rotation exists or is needed at this scale. The runbook step is explicit: check the telemetry dead-man's-switch, then either redeploy a previous Edge Function tag, restore the last DB dump, or use the manual gameweek-override endpoint (§5) as a lighter-weight fix that doesn't require a rollback at all.
- **Time to roll back:** frontend — seconds (platform-measured). Edge Functions — to be measured once the CLI deploy is rehearsed. Database restore from a manual dump — **not fast**; realistically tens of minutes to longer depending on dump size and how much manual reconciliation is needed to avoid losing predictions submitted after the dump was taken. This asymmetry is the reason migration discipline (below) matters more here than the mechanism itself.
- **One-way doors:** any destructive column/table drop applied without first taking a fresh dump is one-way on the free tier, because there is no PITR to fall back on. Expand/contract is not a nicety here — it is the only migration discipline available:
  1. **Expand** — add new nullable columns/tables. Ship.
  2. **Migrate** — backfill, write to both shapes if needed. Ship.
  3. **Switch** — Edge Functions read from the new shape. Ship.
  4. **Contract** — drop the old shape, in a later release, only after taking a manual dump first and only once confident.
- **Migration safety:** expand-only for the whole build; no combined schema-change-plus-behaviour-change release.

## 7. Threat model (STRIDE-lite)

| Threat | Applies? | Mitigation | NFR |
|---|---|---|---|
| Spoofing | Yes, among players — no accounts means anyone can submit under any pseudo, including someone else's. Not applicable to admin. | Accepted risk for players (spec explicitly has no accounts/passwords — see assumptions). Admin routes require a Supabase Auth session scoped to Lio's own account. | `/admin/*` requires an authenticated session; player routes require none |
| Tampering | Yes — a player could tamper with client state (edited JS, stale page) to attempt a late submission. | Backend is the sole authority: every submit is checked against `games.starts_at` server-side, never trusting client-reported lock state (AC-01, AC-02). All writes go through Edge Functions; RLS blocks public INSERT/UPDATE on `predictions`/`games`/etc. entirely, so there's no PostgREST bypass of that check. | server-side lock check on every write; RLS denies public writes outside Edge Functions |
| Repudiation | Low — a player could claim a different pick than what's recorded. | `predictions.submitted_at` plus the optional email receipt (AC-12) give the player their own proof; no stronger guarantee needed given the no-accounts design. | none beyond what the schema already records |
| Information disclosure | Yes — spec explicitly requires players can't see others' picks before lock. | Read endpoints must never return other players' predictions for not-yet-locked matches; only the requester's own (matched by pseudo) and post-lock aggregate data. | red-gate test asserting pre-lock picks are invisible across sessions |
| Denial of service | Yes — the public, unauthenticated submit endpoint is a plausible target for scripted spam (fake pseudos polluting the duplicate queue, or burning the 500k/month Edge Function budget). | Rate-limit the submit endpoint per IP/session at the Edge Function level. Proportionate to a hobby-scale game, not over-built. | submit endpoint rate-limited (e.g. N/minute/IP) |
| Elevation of privilege | Yes — a player could discover an `/admin/*` URL and attempt an admin action. | Every admin route verifies the Supabase Auth session server-side; no route is "hidden but reachable." | authenticated-session check on every admin route, not just route obscurity |

## 8. Observability

- **Logged:** all 8 required telemetry events land in `telemetry_events` (§`contracts/db-schema.sql`), the single store both the success-metric analysis and any future dashard reads from.
- **Measured (the metric this build exists to move):** weekly manual admin time is not directly emitted — it is derived by summing `admin_manual_intervention.duration_minutes_estimate` per week. Since the baseline itself is `unknown — must be measured before release` (per `spec-header.json`), these events **must run in production before the old process is retired**, or there is nothing to compare the post-release number against. This is a sequencing constraint on delivery, not a nice-to-have — flagged here per the bob-instrumentation gate requirement.
- **Counter-metric (scoring/classement accuracy must not regress):** not a telemetry event — verified by the acceptance-criteria test suite (AC-03, AC-04, AC-05, AC-08, AC-14 cover the scoring-correctness surface directly) plus `scoring_run_completed.players_scored_count` as a sanity signal (a gameweek with an implausible scored-count is worth a manual look).
- **Alerts:** the dead-man's-switch described in §6 (missing `gameweek_closed`/`scoring_run_completed` within their expected windows) is the only alerting this build has, since Supabase gives none natively for scheduled-job failure. This must be built, not assumed.
- **What tells us this specific feature is broken:** a gap in the expected telemetry sequence for a given league/gameweek (e.g. `gameweek_opened` with no matching `gameweek_closed` well past the last match's kickoff) is the signal that something silently failed — this is why the events are load-bearing for operations, not just for the success-metric report.

## 9. Slicing

14 acceptance criteria across 3 leagues, a player-facing surface, an admin
surface, and a scheduled-ingestion surface is past the "roughly eight ACs or
several surfaces" threshold for treating this as one undifferentiated piece of
work. Sliced into three children (`bob split`):

| Child | Covers | Shares an interface with |
|---|---|---|
| `core-engine` | Schema, submit/overwrite/lock enforcement (AC-01, 02, 11), gameweek transitions (AC-06, 07), scoring (AC-03, 04, 05, 08, 14), league-config extensibility (AC-13) | `contracts/openapi.yaml` (consumed by the frontend); the normalized match/result shape produced by `fixture-ingestion` |
| `fixture-ingestion` | Per-league scraping adapters + fallback source, normalizing into `games`/`gameweeks` | The same normalized-record shape `core-engine` reads; independently testable against recorded fixtures, the highest-risk/least-parallelizable item regardless of who builds it |
| `player-identity-and-admin-review` | Device-side pseudo prefill (AC-10), email receipts (AC-12), duplicate-pseudo detection + review queue + manual override (AC-09), `admin_manual_intervention`/`duplicate_flagged` telemetry | `contracts/openapi.yaml`'s `/admin/*` paths and the `duplicate_flags` table |

**This must be said plainly, not glossed over:** Lio confirmed proceeding with
the full scope, all three leagues together, with no phased fallback if time
runs short (spec §9). These three children can be *built and tested* in
parallel against the shared contract and schema — that's the entire benefit of
slicing here — but they still all land in one release. Slicing reduces build
coordination cost under the tight timeline; it does not reduce release risk,
and none of the three delivers standalone value shipped alone.
