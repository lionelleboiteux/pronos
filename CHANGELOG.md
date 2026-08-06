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

## Future Work (Before Season Start)

The following four telemetry event types have correct domain logic but lack the pg_cron/pg_net entry points to fire in production:

- `match_locked` — will be fired by a minute-interval cron job that checks for newly-locked matches
- `gameweek_opened` — will be fired when the automatic gameweek-transition cron advances to the next gameweek
- `gameweek_closed` — will be fired when the last match of a gameweek kicks off
- `duplicate_flagged` — will be fired by a weekly cron job that runs the duplicate-detection scan

These do not block deployment or MVP because the event *logic* is proven correct; only the *scheduler registration* remains. Only `admin_manual_intervention` directly feeds the registered "weekly admin time" success metric — but all required events must be running in production before the old spreadsheet process is retired, since the baseline itself is unmeasured and the comparison window can't be recovered later.

**Fixture ingestion is not part of this build at all.** Fetching real match
results (per-league scrapers / a fallback API) is a separate slice
(`fixture-ingestion`) with its own red gate, never run in this repo — no
adapter code exists under `src/`. Everything shipped here assumes `games`
rows and their scores already exist in the database; populating them from
real fixtures is future work, not a pending wiring step like the four events
above.

## Known Limitations

- **No backups on Free tier:** Supabase Free has no daily backups or point-in-time recovery (PITR is a $100/month Pro+ add-on). Mitigated by mandatory expand-only schema migrations and manual `pg_dump` before destructive changes.
- **Rate limit shared IP collision:** Players sharing a household/office IP are affected by the 10 req/min limit; this is a known trade-off acknowledged and accepted.
- **Fixture ingestion doesn't exist yet:** no scraper or API adapter code is in this repo (see Future Work above) — this build only proves the game engine against `games` rows however they get populated.
