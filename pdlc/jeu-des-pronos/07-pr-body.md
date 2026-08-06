## Summary

Consolidates Jeu des Pronos — the 13-year-old football prediction game
currently run by hand across 9 spreadsheets and per-league Make.com
scenarios (Ligue 1, Premier League, Bundesliga) — into a single Supabase
Postgres + Edge Functions + pg_cron application, built test-first through
Bob's full pipeline (adopt → architecture → red → green → verify → polish).

- Scoring, kickoff locking, gameweek transitions, near-duplicate pseudo
  detection, admin overrides, and the 8-event telemetry stream that the
  project's one success metric (weekly manual admin time, target <5
  min/week) is computed from.
- Public read/write API implementing `contracts/openapi.yaml`, contract-tested
  from both sides (Prism consumer mock + Schemathesis provider fuzzing,
  confirmed clean at 10x the frozen suite's fuzz depth at the verify gate).
- Postgres schema as expand-only migrations (`db/migrations/`), RLS locked to
  `service_role` only — no direct PostgREST write path exists for either
  frontend.
- 118/118 tests passing (unit, DB, contract, e2e against real Postgres via
  Testcontainers), `tsc --noEmit` clean.

## What this does not do

- **The pg_cron entry point isn't wired yet.** `gameweekTransition.tick()`
  and `duplicateDetection.runWeeklyDuplicateScan()` are correct, fully
  tested pure functions with no caller anywhere in `src/` — the scheduled
  Edge Function that would invoke them on a cron cadence doesn't exist as
  runnable code in this repo. `match_locked`, `gameweek_opened`,
  `gameweek_closed`, and `duplicate_flagged` are proven at the unit/schema
  layer only, not end-to-end. This is real, scoped-out-of this build
  deliberately (see `pdlc/jeu-des-pronos/05-verification.v1.md` §4), and
  needs to land before this can run unattended in production.
- No frontend is included in this PR — API and data layer only.
- Out of scope per the original spec: mini-leagues, native mobile app,
  "beat the robot" AI feature, monetisation, Wix migration.

## Notable finding fixed in-flight

The verify gate's security audit caught a HIGH-severity bug in the submit
endpoint's rate limiter (it trusted a client-forgeable `X-Forwarded-For`
header, letting anyone bypass the only DoS mitigation on the public,
unauthenticated `POST /v1/predictions`). Fixed and independently
re-verified with an attacker's-eye-view spoofing test before this gate
passed — see `pdlc/jeu-des-pronos/05-verification.v1.md` §1.

## Test plan

- [x] `npm test` — 118/118 passing (unit, telemetry, DB, contract, e2e)
- [x] `npx tsc --noEmit` — clean
- [x] Contract fuzzing re-run at 10x the frozen suite's depth (verify gate) — clean
- [x] Manual rate-limit spoofing smoke test against a live server — attacker
      blocked, admin-authenticated tooling unaffected
- [x] Instrumentation proof: success metric computed by hand from real
      `telemetry_events` rows, including an idempotent-replay-can't-inflate-it check
- [ ] Real Supabase deployment smoke test — not yet done, no environment
      provisioned in this build

## Refs

Idea: `jeu-des-pronos`
Gates: adopt, architecture, red, green, verify, polish (all in this repo's
`pdlc/jeu-des-pronos/` history). Ship gate is this PR; John's dashboard,
release, and review gates are next and out of scope here.
