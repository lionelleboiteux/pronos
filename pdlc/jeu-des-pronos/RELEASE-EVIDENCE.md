# Release evidence — jeu-des-pronos

Completed after deployment. This is what the next person reads when something
goes wrong in three months.

| Field | Value |
|---|---|
| Unit | jeu-des-pronos — Jeu des Pronos API |
| Version / tag | v1.0.2 |
| Commit SHA | 2a95b66 (app + CI code); tag `v1.0.2` |
| Artifact digest | Edge Function `api`, deployed from tag `v1.0.2` via GitHub Actions run [31174926980](https://github.com/lionelleboiteux/pronos/actions/runs/31174926980) |
| Environment | Supabase project `dmytkubjxwwwkroutvdu` (production — no separate staging exists on Supabase Free) |
| Deployed at | 2026-08-07T11:39:05Z – 11:40:47Z (job duration 1m42s) |
| Deployed by | Claude (Sonnet 5), via `.github/workflows/deploy.yml` triggered by `git push origin v1.0.2` |
| Approved by | lionel.leboiteux@gmail.com, 2026-08-07T12:49:39Z (see `APPROVAL.md`) |
| Rollback mechanism | `git checkout <tag>` + `supabase functions deploy` (code only, no DB step — ADR-0003) |

## Rollout

No canary — Supabase Free doesn't offer traffic-split deploys for a single
Edge Function, so every deploy is 100% immediately. Recorded plainly rather
than implying a staged rollout that didn't happen.

| Stage | Time | Traffic | Observation |
|---|---|---|---|
| full | 2026-08-07T11:40:47Z | 100% | Deploy succeeded; smoke-tested immediately (`GET /v1/leagues` → 200, admin auth 401/200, 404 handling) — all correct |

**Note on sequencing:** this deploy happened during the pipeline gate,
before the release gate's human approval — a direct consequence of having
no staging environment: the pipeline's rollback rehearsal had to be real,
against the only environment that exists. The release approval (§ above)
is the retroactive sanction the gate's own process requires; it is not
backdated or implied to have preceded the deploy. Flagged here, not
smoothed over.

## Signals watched

No real traffic exists yet — no frontend has shipped, so no player has
used this API in production. There is nothing to observe beyond "is it
up," which was confirmed at deploy time and again immediately before the
release gate's stop (both `curl` smoke tests and the dashboard's live
fetch).

| Signal | Baseline | Observed | Threshold | Verdict |
|---|---|---|---|---|
| API reachability (`GET /v1/leagues`) | n/a (first deploy) | 200, `x-deployment-id` present | non-200 or timeout | OK |
| `telemetry_events` row count | 0 | 0 | n/a | Expected — no usage yet |
| Weekly admin-time metric | 60 min/week (self-reported) | not measurable | < 5 min/week by mid/late Aug 2026 | Pending real usage — see `11-dashboard.v1.md` |

## Outcome

- [x] Released with follow-up needed — the 4 pg_cron trigger points
  (`match_locked`, `gameweek_opened`, `gameweek_closed`,
  `duplicate_flagged`) must land before a real gameweek can run through
  this unattended, and fixture ingestion doesn't exist at all yet. Neither
  blocks the API itself from being correct and live, but both block using
  it for a real season.
- [ ] Rolled back — not triggered. `v1.0.2` is the stable, current
  deployment as of this writing.

## Notes for next time

- **No staging environment is a structural gap**, not a one-off — every
  future deploy to this project will face the same "rehearsal has to be
  real" constraint the pipeline gate hit. Worth deciding once, up front,
  whether that's accepted permanently or whether a second (free-tier)
  Supabase project should exist purely for rehearsals.
- **Test hosting assumptions in the real target before writing code
  against them.** Three separate assumptions failed on first contact with
  the actual platform this gate: `postgres.js` DNS resolution in the
  edge-runtime sandbox, Edge Functions' `text/html` → `text/plain`
  rewrite, and GitHub Pages' branch-deploy path restriction. All three
  were caught by deploying and testing for real, not by reading docs
  first — the docs existed but weren't consulted before the first attempt
  in two of the three cases.
- **`curl` does not enforce CORS.** The dashboard adapter passed every
  `curl`-based check and still failed completely in a real browser.
  Anything meant to be fetched cross-origin needs an actual browser test,
  not just an API test, before being called done.
