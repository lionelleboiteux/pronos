# ADR-0001: Supabase Postgres + Edge Functions + pg_cron as the backend

- **Status:** accepted
- **Date:** 2026-08-03
- **Unit:** jeu-des-pronos
- **Deciders:** Lionel Le Boiteux, Claude (Sonnet 5)

## Context

The spec fixes three constraints and leaves the rest as a build decision: £0 budget,
config-only extension to a 4th league (AC-13), and an API layer between the
datastore and the player-facing form. Three genuinely distinct architectures
were explored: Cloudflare Workers/D1/Cron Triggers, a managed long-running
service (Render) with Postgres and an external scheduler, and Airtable as the
system of record. Independently of that exploration, Lio had already designed
a relational Postgres schema for Supabase covering the full domain (leagues,
seasons, teams, players, gameweeks, games, predictions, scores, standings).

## Decision

Use Supabase Postgres (Lio's schema, extended — see `contracts/db-schema.sql`)
as the datastore, Supabase Edge Functions as the only write path and API
layer, and `pg_cron`/`pg_net` (confirmed shipped enabled on Supabase's Free
plan in 2026) for all scheduled work — match-lock/gameweek-transition ticks,
the morning-after scoring run, and per-league fixture ingestion.

## Consequences

**Positive**
- Scheduling runs next to the data, at minute-level cron granularity, with no
  external wake-up mechanism needed — this removes the scheduling-precision
  failure mode that ruled out the Render option (GitHub Actions cron drift
  stacked with a sleeping container's cold start).
- Builds directly on real prior work (Lio's schema) instead of discarding it.
- Free-tier headroom (500k Edge Function invocations/month, unlimited
  PostgREST requests) holds at both expected load and 10x.
- Postgres row counts aren't subject to Airtable's per-base record cap, which
  would have been exhausted by match rows alone within one season.

**Negative**
- Supabase Free has **no backups and no PITR** (confirmed; PITR is a $100/mo
  Pro+ add-on) — a bad migration has no vendor safety net. Addressed by
  mandatory expand/contract migrations plus a manually-scheduled pre-migration
  dump (see ADR-0003), which is a real build task, not a platform feature.
- Edge Functions have no platform-native rollback (dashboard editing has no
  versioning) — rollback is git-tag-and-redeploy via CLI, slower than a
  one-click promotion.
- Ties both the datastore and the scheduling model to Supabase specifically;
  migrating away later means re-hosting Postgres and rebuilding the pg_cron
  harness, not just redeploying.

**Neutral / accepted**
- Everything is greenfield, so there was no existing system pulling toward a
  different stack for compatibility reasons.

## Options rejected

| Option | Why not |
|---|---|
| Cloudflare Workers + D1 + Cron Triggers | Free-tier headroom is excellent, but Cron Triggers cap at 5/account and D1's only free recovery mechanism (Time Travel) is a whole-database restore, not per-record — comparable weaknesses to what was accepted here, with less benefit given Lio's schema was already Postgres-shaped |
| Render (long-running service) + Neon/Supabase Postgres + external GitHub Actions cron | Fly.io has no real free tier since 2024 and Render's free tier has no free cron product, forcing an external scheduler bolted onto a sleep-on-idle container; the resulting scheduling lag (tens of minutes, worst case) risks AC-06/AC-07 directly |
| Airtable + thin serverless API | Free-plan record cap (1,000/base) is exhausted by match rows alone within one season, not at 10x; workable version needs ~$20/month, breaking the confirmed £0 assumption; and its core appeal (direct grid editing) bypasses the API layer entirely, defeating the admin-audit telemetry the project depends on |

## Revisit when

Traffic grows enough that Supabase's shared 500MB-RAM free compute becomes a
real bottleneck (unlikely at this game's scale, per §4 of the architecture
doc), or if Supabase changes free-tier terms materially (e.g. removes
`pg_cron` from Free, as it has changed API/backup terms before) — re-verify
current terms before assuming this decision still holds.
