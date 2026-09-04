# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Adopt Gate

**Initial project scope and success metrics.**

- Defined 14 acceptance criteria covering player form submission, lock enforcement, scoring, duplicate detection, gameweek automation, standings, and extensibility.
- Set measurable NFRs: server-side lock authority, idempotent submissions, rate limiting, RLS-enforced read isolation, admin authentication.
- Established success metric: reduce weekly manual admin time from ~1 hour to under 5 minutes.
- Scoped out: mini-leagues, mobile apps, AI features, monetization, Wix migration.
- Confirmed budget constraint: zero cost (free-tier only).

### Architecture Gate (2026-08-03)

**Evaluated three architecture options; chose Supabase Postgres + Edge Functions + pg_cron.**

- Evaluated Cloudflare Workers/D1/Cron Triggers, Render/Postgres/GitHub Actions, and Airtable; found scheduling precision gaps and record-cap cliffs in alternatives.
- Adopted Supabase Postgres (using Lio's pre-existing schema as the foundation), Supabase Edge Functions as the sole write path, and `pg_cron`/`pg_net` extensions for scheduling.
- Designed API contract (OpenAPI 3.1): 8 operations across player submission, league state, standings, and admin override endpoints.
- Threat model (STRIDE-lite): identified spoofing (accepted), tampering (mitigated by server-side lock check + RLS), information disclosure (read isolation), DoS (rate limiting).
- Cost and free-tier analysis: confirms 9-15% utilization of key meters (Edge Function invocations, DB storage) at 1x load and 10x traffic; identifies backups as the one real gap (Supabase Free has no PITR).
- Created three architectural decision records (ADRs) covering the platform choice, player identity model, and migration safety discipline.

### Red Gate (2026-08-03)

**Built complete test suite (118 tests) as failing tests before any production code.**

- Wrote 118 Vitest tests covering all 14 acceptance criteria, all NFRs, all 8 API contract operations (Prism consumer + Schemathesis provider), telemetry events, and two critical journeys.
- Tests include unit tests for pure domain logic (scoring, lock checks, gameweek transitions, duplicate detection), integration tests against real Postgres 16 via Testcontainers, property-based invariants, and security-specific assertions (information isolation, RLS).
- Established test harness: Prism mock (consumer validation), Schemathesis (provider contract fuzzing), Testcontainers (real Postgres), deterministic fixtures matching OpenAPI examples.
- Suite confirmed: 117 failing, 1 passing (contract-coverage guard). Ready for green gate.

### Green Gate

**Wrote minimum production code to pass all 118 tests.**

- Implemented database schema (migrations using expand-only discipline, no destructive changes) with all tables, constraints, RLS policies, and views needed for the domain.
- Wrote all 8 API endpoint handlers in Edge Functions: submission with upsert semantics and idempotency keys, league/gameweek state reads, standings projections, admin overrides with telemetry emission.
- Implemented domain logic: scoring (5/3/2/0 matrix, double-gameweek summation, blank-gameweek handling), lock enforcement (server-side authority on `games.starts_at`), gameweek transitions (per-league independence), duplicate-pseudo detection (string-distance algorithm).
- Implemented telemetry: 8 event types defined, shapes tested, emission wired for four types (prediction_submitted, prediction_rejected_late, scoring_run_completed, admin_manual_intervention); logic correct for the other four (match_locked, gameweek_opened, gameweek_closed, duplicate_flagged) but cron entry points pending.
- Confirmed all 118 tests passing; `tsc --noEmit` clean.
- Known gap at end of gate: rate limiter trusted client-supplied `X-Forwarded-For` header, later fixed in verify gate (see below).

### Verify Gate (2026-08-05)

**Fixed security issue in rate limiting; added performance indexes; deepened integration testing.**

- **Security fix (HIGH severity):** Rate limiter was trusting client-supplied `X-Forwarded-For` header, allowing an attacker to spoof per-request IP and defeat NFR-RATE-01 (10 req/min/IP limit), while also enabling email bombing via unthrottled submissions. Fixed by using `req.socket.remoteAddress` (the true TCP peer) instead. Added exemption for admin bearer token so Schemathesis's fuzzing (which legitimately bursts from one process) is not rate-limited; uses existing admin JWT trust boundary.
- **Performance (proactive, not yet measurable):** Added four indexes to `games`, `predictions`, and standings tables, because EXPLAIN showed sequential scans on frequently-filtered columns. Enables future growth without query-plan regression as accumulated rows grow.
- Confirmed both fixes with independent re-verification: 118/118 tests passing, `tsc --noEmit` clean.
- Verified free-tier budget math: at 1x and 10x load, Edge Function invocations stay 9-15% of 500k/month quota; storage projections show multi-year runway before hitting 500MB.
- Verified latency: single-digit to low-teens milliseconds p95 on real Testcontainers Postgres at both 1x and 10x row volumes.

### Polish Gate (2026-08-05)

**Removed one dead code parameter; lint review.**

- Removed unused `now: Date` parameter from idempotency `remember()` function signature (both production and seams).
- Reviewed codebase against TypeScript standards: identified two large functions for future refactoring (no action at this gate), confirmed all injection sites, no missing security controls found.
- Confirmed suite still 118/118, `tsc --noEmit` clean; no test assertions changed.

### Gameweek Transition Cron Wiring (2026-08-25)

**Diagnosed and fixed: gameweek transitions never actually ran in production.** Premier League, Ligue 1, and Serie A had every gameweek-1 match finished, well past kickoff, but were still showing gameweek 1 as open — because nothing had ever called `gameweekTransition.tick()` on a schedule, despite it being correct, unit-tested logic since the initial build.

- Added `POST /v1/internal/tick` (`src/api/tick.ts`), a machine-to-machine endpoint (same trust tier as `/v1/ingest/fixtures`) that runs `tick()` against each league's current gameweek and persists the result: `match_locked` events for newly-passed kickoffs, and `gameweek_closed`/`gameweek_opened` plus the `leagues.current_gameweek_id` update once a gameweek's last match has kicked off.
- Added `db/migrations/20260825090000_schedule_gameweek_transition_tick.sql`, scheduling that endpoint via `pg_cron`/`pg_net` every minute. Every statement is wrapped in exception-swallowing `DO` blocks so the migration stays a harmless no-op against the plain Postgres image the DB test suite runs migrations against (`pg_cron`/`pg_net`/Vault only exist on managed Supabase).
- One manual step this migration can't do for you: the job's bearer token can't be committed to git, so `select vault.create_secret('<the INGEST_TOKEN value>', 'tick_token');` must be run once from the Supabase SQL editor before the scheduled call will authenticate.
- Added `tests/unit/tick.test.ts` (6 tests) covering auth, event persistence, the not-yet-locked no-op case, and the "no next gameweek ingested yet" case (left `current_gameweek_id` null rather than guessed at, same as the existing manual override's behavior).
- Corrected this changelog's and the README's "Future Work"/"Current Status" sections, which had gone stale: fixture ingestion (`scripts/ingestion/`, `.github/workflows/ingest-fixtures.yml`) was in fact already built and running hourly for all 5 leagues, contrary to the "not part of this build at all" note previously here.

### Migration History Reconciliation (2026-08-25)

**Deploying the tick migration above surfaced pre-existing drift between this repo and the live database.** `supabase db push` refused to run at all, reporting 7 remote migration versions (`20260823203048` through `20260824072538`) with no corresponding files anywhere in `db/migrations/` or in this repo's git history — schema changes applied directly against the live project between the v1.1.2 deploy (Aug 11) and this one, never captured as committed migration files.

- Unblocked via `supabase migration repair --status reverted <version>` for each of the 7 versions, run directly against the live project. This only edits Supabase's migration-tracking table, not the database's actual schema — whatever those 7 migrations changed remains live and in effect; they are simply no longer expected to have a matching local file.
- Along the way, the same `repair --status applied` shortcut was tried on this branch's own tick migration (`20260825090000`) to sidestep re-running `supabase db push`. That doesn't work: `migration repair` never executes a migration's SQL, so it left the tracking table claiming success while the `pg_cron` job was never actually scheduled and the Edge Function was never redeployed (confirmed live: `POST /v1/internal/tick` 404'd, all three affected leagues still on gameweek 1). Reverted that one mark and re-ran the deploy for real.
- **Net effect:** the live schema is presumed correct (nothing was rolled back), but this repo's migration files no longer fully describe it. See the new Known Limitations entry below.

### Contract-Fuzzing False Positive Fix (2026-08-25)

**Deploying the tick migration surfaced a second, unrelated pre-existing issue: `POST /v1/admin/gameweeks/{gameweekId}/override`'s contract test started failing intermittently in CI**, blocking every deploy, not just this one. Root-caused by direct reproduction (`--seed 1` reproduces deterministically) against a local server: Schemathesis's `positive_data_acceptance` check generates a request from the operation's own documented example body while dropping the required `Idempotency-Key` header, then flags the resulting `400` as if the request should have been accepted. `missing_required_header` — the check actually responsible for verifying "reject a request missing a required header" — passes cleanly, confirming the API's behavior is correct and this is a check-level false positive, not a real contract violation.

- `npm run setup:contract` now pins `schemathesis==4.25.2` instead of installing unpinned-`latest` — this project already hit the same failure mode once with `supabase/setup-cli@v1` (see v1.0.2), and unpinned tooling is what let this behavior surface without any change to this repo's own code.
- `tests/support/schemathesis.ts` now passes `--exclude-checks positive_data_acceptance`. Verified narrow and safe, not masking real coverage: re-ran the full 9-operation suite with the exclusion applied (878/878 generated cases passed) and 15 additional random-seed runs at production's `--max-examples 5` (15/15 passed), rather than just re-running until the flake didn't hit.

### Automated Post-Close Scoring (2026-08-26)

**Once gameweeks actually started advancing in production, gameweek 1's points still weren't showing.** Same shape of gap as the cron wiring above, one step further down the pipeline: `runScoring()` (the 5/3/2/0 scoring engine) has existed as correct, tested logic since the initial build, but was only ever wired to the manual admin "rescore" action — nothing ran it automatically when a gameweek closed, so a closed gameweek's classement stayed empty (`GET .../standings` returning `data: []`) until an operator rescored it by hand.

- `src/db/repository.ts`: extracted the compute-and-persist-standings logic shared by the admin "rescore" action and the new automated path into `computeAndPersistScoring()`. Added `runScoringForGameweek(gameweek_id, now)`, which checks `already_completed` for real against `telemetry_events` (unlike the always-force manual action) so an overlapping or retried cron tick can't double-score the same gameweek.
- `src/api/tick.ts`: `handleTick()` now calls `runScoringForGameweek` for every gameweek that closes this tick, before advancing `leagues.current_gameweek_id` — no separate migration or deploy step needed beyond what `20260825090000_schedule_gameweek_transition_tick.sql` already schedules, since this runs inside the same `POST /v1/internal/tick` call.
- Verified end-to-end against a real local Postgres (not just mocks): seeded a finished match with a prediction, called the real router's `/v1/internal/tick`, confirmed `GET .../standings` went from empty to the correct 5/3/2/0 points, and confirmed a second tick call is a clean no-op (no duplicate scoring, no error) once the gameweek is no longer current.
- Added 2 tests to `tests/unit/tick.test.ts` (scoring runs on close; still runs even when there's no next gameweek to open yet).

### Season-Long Standings Never Had a Writer (2026-08-26)

**Gameweek scoring started working, and gameweek-level standings showed correct points — but the live site's main "classement général" card still showed nothing.** That card reads a completely different table: `GET .../standings/overall`, backed by `overall_standings`, not `league_gameweek_standings`. Checked the whole codebase: nothing anywhere ever wrote to `overall_standings` — it's a plain table with no trigger, no view, no refresh logic, permanently empty since the initial build.

- Added `refreshOverallStandings(season_id)` to `src/db/repository.ts`: a straight sum-and-`rank()` over every `league_gameweek_standings` row in a season, upserted into `overall_standings`. Called from `computeAndPersistScoring()` — the same function both the manual admin "rescore" action and the automated tick-triggered scoring already run through — so the season total stays in sync with per-gameweek scoring automatically, no separate cron entry point needed.
- Added `tests/db/overallStandings.test.ts` (3 tests: populated on first score, sums correctly across multiple gameweeks in a season, idempotent on a repeated call) — verified passing against a real local Postgres.

### Gameweek Transition Dead End When the Next Gameweek Isn't Ingested Yet (2026-08-28)

**La Liga stalled on gameweek 2 with `GET /v1/leagues/{id}/current` returning `gameweek: null, games: []`, well after gameweek 3 should have opened**, while the other four leagues kept advancing normally. Root cause: `gameweekTransition.tick()` (wired up in the cron entry above) closes a gameweek and, if the next one isn't already a row in `gameweeks`, sets `leagues.current_gameweek_id` to `null` — treating "not ingested yet" exactly like "end of season". That null is unrecoverable by anything automated: `listOpenGameweekStates()` finds a league's current gameweek with an inner join on `current_gameweek_id`, so a null value drops the league out of every future tick permanently; and `scripts/ingestion/ingest_fixtures.py`'s `target_gameweek_number()` falls back to gameweek 1 whenever the API reports no current gameweek, so the hourly fixture sync could never discover gameweek 3 either — it just kept re-syncing the (already finished) gameweek 1. The two automated pipelines had talked each other into a permanent deadlock, exactly as the "no next gameweek ingested yet" test case added in the cron-wiring gate had encoded as intended behavior, rather than a gap.

- `src/domain/gameweekTransition.ts`: `advanceLeague()` now holds `current_gameweek_id` on the just-closed gameweek when its successor doesn't exist yet, instead of nulling it — keeping the league reachable by both `listOpenGameweekStates()` and the fixture sync's "current gameweek, all matches finished → target is number + 1" logic until the real next gameweek's row shows up. Added `GameweekState.closed_event_emitted`, mirroring the existing per-match `lock_event_emitted` guard, so `gameweek_closed` fires exactly once even though the gameweek can now stay "current" across many ticks while waiting.
- `src/db/repository.ts`: `listOpenGameweekStates()` derives `closed_event_emitted` from `telemetry_events` (same pattern as the existing `lock_event_emitted` derivation), and its doc comment no longer describes the null-on-no-successor behavior as deliberate.
- `src/api/tick.ts`: the `leagues.current_gameweek_id` write-back now triggers on either a `gameweek_closed` or a `gameweek_opened` event this tick, not just `gameweek_closed` — needed because a stalled league's eventual transition to the real next gameweek now arrives as a `gameweek_opened` event on its own, several ticks after the `gameweek_closed` that was already emitted (and written back) when it first stalled.
- Updated `tests/unit/tick.test.ts`'s "no next gameweek ingested yet" case, which had asserted the old (buggy) null-and-forget behavior, plus 3 new cases; added 4 new cases to `tests/unit/gameweekTransition.test.ts` covering the stall-then-recover sequence. 39/39 relevant tests and the full 107-test unit/telemetry suite pass; `tsc --noEmit` clean.
- **Does not by itself fix live data:** this closes the trap for every future occurrence, but La Liga's `leagues.current_gameweek_id` is already `null` in production from before this fix shipped, so it still needs one manual nudge — an admin `POST /v1/admin/gameweeks/{id}/override` `open` on its already-ingested, fully-finished last gameweek (gameweek 2's `gameweeks` row already exists) to give the tick a current gameweek to resume from. Once that's done, the fixed pipeline takes it from there on its own.

### Classement Général Per-Gameweek Breakdown (2026-08-31)

**A player's Bundesliga gameweek 1 score showed 11 on the live site when the actual predictions and final results computed to 13.** Root cause: `runScoring()`'s only gate for closing a gameweek and scoring it is `isLocked(now, last_kickoff_at)` (`src/domain/lock.ts`), which is just "the last match's kickoff time has passed" — not "the match has finished." The pg_cron tick fires every minute, so scoring ran within a minute of the last kickoff, against whatever placeholder values were in `games.home_team_score`/`away_team_score` at that instant, hours before the real final scores were ingested. The `already_completed` guard (by design, so a retried tick can't double-score) then locked the stale result in permanently. Confirmed this affected two already-scored gameweeks (Bundesliga GW1, Ligue 1 GW2) by comparing each `scoring_run_completed` timestamp against `games.updated_at`; both were manually rescored via the admin override endpoint to correct `league_gameweek_standings` and (via the existing `refreshOverallStandings` cascade) `overall_standings`. The underlying trigger-timing bug itself is fixed separately below ("Scoring No Longer Triggers on Kickoff Time").

While investigating, restored a feature the old spreadsheet-era site had that the current API never exposed: the "Classement général" card showing each player's score broken down per gameweek, not just the season total.

- `src/db/repository.ts`: `getOverallStandings()` now also returns `gameweeks` — the season's up-to-10 most recently *scored* gameweeks (oldest first) — and each row carries a `gameweek_points` array index-aligned to it (null where that player has no `league_gameweek_standings` row for that gameweek).
- `pdlc/jeu-des-pronos/contracts/openapi.yaml`: added `GameweekSummary` and `OverallStandingsEntry` schemas; `OverallStandingsResponse` now requires `gameweeks`, and `data` items require `gameweek_points`.
- `frontend/index.html`: `renderClassementCard()` renders one column per gameweek (header "J{number}") plus a Total column, with a horizontal-scroll wrapper for leagues with many scored gameweeks.
- `tests/db/overallStandings.test.ts`: extended the existing 3 tests to assert `gameweeks` and `gameweek_points`, including the multi-gameweek case where gameweek numbers don't sort in insertion order.

### Scoring No Longer Triggers on Kickoff Time (2026-08-31)

**Follow-up to the fix above: gates scoring on `games.status = 'finished'` instead of kickoff time, closing the bug rather than just correcting its two known victims.**

- `src/domain/scoringRun.ts`: `ScoringRunInput.all_games_finished` (a plain boolean the caller computes) replaces `last_kickoff_at` + `isLocked()` as the readiness gate. Predictions still lock the instant the last match kicks off (that's unchanged, and correct — `lock.ts` isn't touched); only the *scoring* trigger now waits for real results.
- `src/db/repository.ts`: `computeAndPersistScoring()` derives `all_games_finished` as `bool_and(games.status = 'finished')` over every game in the gameweek (false, not null, when a gameweek has zero games). Also now returns whether it actually ran, so `applyAction()`'s `rescore` branch reports `applied: false` instead of a false `true` when called on a gameweek whose matches aren't finished yet — the equivalent of what silently happened before, just now visible in the response.
- **Retry design, the part that actually matters:** `gameweek_closed` fires and is guarded exactly once per gameweek (`gameweekTransition.ts`, unchanged), and a league can advance past a gameweek's `current_gameweek_id` before its matches finish. Gating scoring on kickoff-vs-finished alone, without also changing *when* it's retried, would have just moved the exact same class of bug one step down the pipeline: `src/api/tick.ts` used to call `runScoringForGameweek` only for gameweeks that closed *that specific tick*, so a gameweek not yet finished at its one closing-tick call would never be retried again. Added `repository.ts`'s `listGameweeksAwaitingScoring()` — every gameweek with a `gameweek_closed` event but no `scoring_run_completed` event, sourced from telemetry rather than `listOpenGameweekStates()` specifically so it keeps finding a gameweek regardless of how far the league has since moved on — and `tick.ts` now calls it, and retries scoring for everything it returns, on every tick.
- `pdlc/jeu-des-pronos/contracts/openapi.yaml`: documented that `action: rescore` can now be accepted (`200`) but a no-op (`applied: false`) when the gameweek's matches aren't finished yet, distinct from the existing `409 CONFLICT` for a gameweek that hasn't even reached kickoff.
- `tests/db/scoringReadiness.test.ts` (new, 3 tests against real Postgres): a gameweek isn't scored while its match is still `'scheduled'` despite kickoff having passed; it scores automatically on a later retry once marked `'finished'`; a multi-match gameweek waits for every match, not just the first, to finish.
- `tests/unit/scoringRun.test.ts`: added the `all_games_finished: false` skip case. `tests/unit/tick.test.ts`: added a case proving scoring keeps retrying for a closed gameweek across ticks even after the league's `current_gameweek_id` has moved past it — the regression this fix exists to prevent.
- 129/129 relevant unit/telemetry/contract tests and 6/6 relevant DB tests (3 existing + 3 new) pass; `tsc --noEmit` clean.

### Admin `open` Override No Longer Leaves a Silent Scoring Gap Behind It (2026-08-31)

**La Liga's "Classement général" showed only gameweeks 2 and 3, never 1, despite gameweek 1 being fully played (10/10 matches finished).** Root cause: `action: open` (`repository.ts`'s `applyAction`) sets `leagues.current_gameweek_id` straight to the target gameweek — the recovery tool for a league whose current gameweek is stuck or null. On 2026-08-28, La Liga's stall (CHANGELOG "Gameweek Transition Dead End") was recovered with an admin `open` straight onto gameweek 2, which jumped `current_gameweek_id` there directly without ever emitting gameweek 1's `gameweek_closed` event. Since scoring only ever triggers off a gameweek having closed, gameweek 1 was silently skipped forever — fully played, never scored, permanently missing from the classement, with nothing in the automated pipeline ever going to notice or fix it.

- `src/db/repository.ts`: added `closeSkippedGameweeks()`, called by `applyAction` before every `action: open` — finds every earlier gameweek in the same season missing a `gameweek_closed` event, closes and scores each one (reusing the same already-scored check `runScoringForGameweek` uses, so it's safe to call on every `open`, not just recovery ones). Live La Liga GW1's data (fully finished, never scored) still needs one manual `rescore` call to backfill — this fix only prevents the gap from recurring on a future recovery, it doesn't retroactively fix data from before it shipped.
- `tests/db/adminOpenBackfill.test.ts` (new, 2 tests against real Postgres): opening a later gameweek backfills an earlier, fully-finished, never-closed one; opening again doesn't double-close or double-score a gameweek that was already closed.

### Backfilled Predictions No Longer Need a Manual Rescore (2026-09-04)

**A player's picks retroactively backfilled straight into Postgres for an already-scored gameweek (Serie A GW2, "Mailliw H") stayed permanently unscored until someone ran the admin `rescore` action by hand — and it had to be re-run by hand every time it happened again.** Root cause: `runScoringForGameweek`'s and `listGameweeksAwaitingScoring`'s notion of "already scored" was existence-only — once a single `scoring_run_completed` event existed for a gameweek, the automated pg_cron tick treated it as permanently done and never looked at it again, no matter what predictions arrived afterward. Since a prediction can only be added post-kickoff by writing directly to `predictions` (the API's kickoff lock, `lock.ts`, forbids it everywhere else — see the La Liga J3 backfill earlier this session), every such backfill needed its own manual admin call to actually count.

- `src/db/repository.ts`: both `runScoringForGameweek`'s `already` check and `listGameweeksAwaitingScoring`'s query now compare the gameweek's `scoring_run_completed.occurred_at` against `max(predictions.updated_at)` for that gameweek, not just existence — a `scoring_run_completed` event older than the newest prediction is treated as stale, not done. A gameweek backfilled after being scored is picked up again on the very next automated tick, with no manual `rescore` call needed.
- `tests/db/scoringReadiness.test.ts` (2 new tests against real Postgres): a prediction inserted directly into Postgres after a gameweek was already scored gets folded into standings on the next `runScoringForGameweek` call with no admin action, and a further tick with nothing new stays a no-op (idempotency preserved); `listGameweeksAwaitingScoring` surfaces the gameweek again once backfilled and stays quiet once nothing has changed.

## Future Work (Before Season Start)

One telemetry event type has correct domain logic but lacks a scheduled trigger in production:

- `duplicate_flagged` — will be fired by a weekly cron job that runs the duplicate-detection scan

This does not block deployment or MVP because the event *logic* is proven correct; only the *scheduler registration* remains.

## Known Limitations

- **No backups on Free tier:** Supabase Free has no daily backups or point-in-time recovery (PITR is a $100/month Pro+ add-on). Mitigated by mandatory expand-only schema migrations and manual `pg_dump` before destructive changes.
- **Rate limit shared IP collision:** Players sharing a household/office IP are affected by the 10 req/min limit; this is a known trade-off acknowledged and accepted.
- **Weekly duplicate scan isn't scheduled yet:** the detection logic is tested but no cron job calls it in production yet (see Future Work above).
- **`db/migrations/` doesn't fully describe the live schema:** 7 migrations (`20260823203048`–`20260824072538`) were applied directly against production between Aug 11 and Aug 25 and were never committed here (see "Migration History Reconciliation" above); they're marked `reverted` in Supabase's tracking table so `supabase db push` no longer blocks on them, but the actual schema changes they made are still live and undocumented in this repo. Anyone with Supabase CLI access should run `supabase db pull` on a clean branch to capture the current live schema into proper migration files and close this gap — an actual, reviewable diff beats guessing at what those 7 changed.
