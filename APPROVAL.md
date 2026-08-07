# Release approval — jeu-des-pronos

This file is the approval. A chat message is not.

- **Unit:** jeu-des-pronos — Jeu des Pronos API (v1.0.2)
- **Commit:** 3ba26f762e9fd9c8aeab63610cced5252ddf7f1f
- **Artifact digest:** git tag `v1.0.2` (Edge Function bundle deployed from this tag via `.github/workflows/deploy.yml`, run [31174926980](https://github.com/lionelleboiteux/pronos/actions/runs/31174926980))
- **Requested by:** Claude (Sonnet 5) on 2026-08-07
- **Approved by:** lionel.leboiteux@gmail.com on 2026-08-07T12:49:39Z
- **Decision:** APPROVED

## What is being released

The full Jeu des Pronos game engine — scoring, server-side kickoff locking,
per-league gameweek transitions, near-duplicate pseudo detection, and admin
overrides — behind 8 API endpoints, running as a Supabase Edge Function
against a real hosted Postgres project. This replaces the manual-scoring
half of the current 9-spreadsheet/Make.com process. No player-facing
frontend ships in this release — API and data layer only.

**Deployment note:** because Supabase Free has no separate staging
environment, the pipeline gate's rollback rehearsal necessarily deployed
against this same live project (with the user's explicit sign-off on that
before it happened). `v1.0.2` has therefore been live since the pipeline
gate, before this approval was requested — this approval is the recorded,
retroactive-in-timing-only human sign-off that the pipeline gate's own
rules require before that deployment counts as sanctioned.

## Acceptance criteria satisfied

AC-01, AC-03 through AC-09, AC-11 through AC-14 — fully satisfied
end-to-end through the API (see `traceability.md`).

AC-02 (kickoff-time grey-out) and AC-10 (pseudo prefill) are satisfied at
the domain/data level only — the backend correctly computes lock state and
would support prefill, but no browser UI exists yet to render either.

## Verification summary

- Tests: 118/118 passing (unit, DB, contract, e2e), `tsc --noEmit` clean —
  confirmed both at the verify gate (2026-08-05) and again just before
  this release gate.
- Security: one HIGH finding at verify gate (client-forgeable
  `X-Forwarded-For` defeating the rate limiter) — fixed and
  re-verified with an attacker's-eye-view spoofing test. Nothing
  outstanding above that severity.
- Performance: Edge Function invocations at ~9.3% of the 500k/month free
  quota at 1x load; DB storage has multi-year runway. Latency:
  single-digit-to-low-teens ms p95 at both 1x and 10x row volumes.

## Rollback

- **Mechanism:** `git checkout <tag>` + `supabase functions deploy`
  (Edge Function code only). No DB step — migrations are expand-only and
  never rolled back (ADR-0003); DB recovery is a manual `pg_dump` before
  any destructive change, which this release does not contain.
- **Rehearsed:** yes — against the live project, via the real
  `workflow_dispatch` rollback job. **Measured time:** 27s job execution /
  44s end-to-end from trigger. Verified via an `x-deployment-id` response
  header that the rollback genuinely changed what code was running, not
  just that the job exited 0.
- **One-way doors:** none from this release's own migrations (both
  additive). A real `ADMIN_TOKEN` secret now gates the 4 admin endpoints
  (rotatable, not truly one-way). No irreversible third-party writes ship
  — email receipts are stubbed, nothing is actually sent yet.

## Conditions attached to this approval

None specified by the approver beyond the summary presented at the release
stop.

## Signature

Approved by: lionel.leboiteux@gmail.com   Date: 2026-08-07T12:49:39Z
