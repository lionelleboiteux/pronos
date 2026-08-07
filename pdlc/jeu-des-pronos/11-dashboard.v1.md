# jeu-des-pronos — Dashboard-gate evidence

> Gate: dashboard (John). Benefit dashboard live, baseline captured before
> real usage begins.

**Status:** dashboard gate | **Author:** Claude (Sonnet 5) | **Date:** 2026-08-07
**Result:** dashboard live at
[lionelleboiteux.github.io/pronos](https://lionelleboiteux.github.io/pronos/),
fetching real (currently empty) data from a live adapter. Baseline captured
below — it is self-reported, not measured, and that's the honest state of
it, not a gap this gate could close.

---

## 1. The metrics, verbatim from Pam's spec (`state.json`)

- **Metric:** weekly manual admin time on gameweek open/close and scoring.
  Baseline: `unknown - must be measured before release (self-reported
  estimate is ~1 hour/week)`. Target: under 5 minutes per week, by
  mid/late August 2026, before the new season starts.
- **Counter-metric:** scoring and classement accuracy must not decrease.

## 2. Baseline capture

**This is where "unknown - must be measured before release" should get
resolved — it doesn't, fully, and that's recorded honestly rather than
papered over.**

The pre-automation process (9 spreadsheets + Make.com scenarios) was never
instrumented — there is no telemetry, no logs, nothing to independently
re-derive a number from. The only figure that has ever existed for it is
Lio's own self-report of ~60 minutes/week, made at the adopt gate. That
self-reported figure is what's captured as the baseline, dated 2026-08-07
(today, the day this gate ran), with its provenance stated plainly on the
dashboard itself rather than presented as if it were measured.

**Current value: not measurable yet, and the dashboard says so rather than
showing a fabricated number.** The system went live today (`v1.0.2`,
pipeline gate). Zero rows exist in `telemetry_events` on the live project —
confirmed directly against the database, not assumed:

```sql
select event_type, count(*) from telemetry_events group by event_type;
-- []
```

No gameweek has run through the new system yet, so `admin_manual_intervention`
— the one event type this metric is actually computed from, and the only
one of the four "wiring pending" events that *is* fully wired per
`04-green-evidence.v1.md` — has had nothing to fire on. **How long is
needed for a stable reading:** at least one full gameweek cycle (the
admin's open → score → close loop, roughly weekly), and ideally 3-4 before
trusting a trend over a one-off. Releasing before then — which already
happened, per the pipeline gate — is a legitimate, already-made decision;
this document is what makes sure it was made knowing the metric is
unprovable until real usage accumulates.

## 3. The data adapter

Per `dashboard-guide.md`'s adapter table, the store Bob instrumented is
"a table in the app database" (`telemetry_events`, Postgres) — so the
adapter is a read-only endpoint returning aggregates as JSON:
[`supabase/functions/dashboard-metrics`](../../supabase/functions/dashboard-metrics/index.ts).

- `admin_manual_intervention` events, summed by `duration_minutes_estimate`,
  grouped by week → the metric's `series`.
- `scoring_run_completed` count, surfaced only as an activity count inside
  the counter-metric's `note` — explicitly *not* presented as an accuracy
  measurement (see §4).
- Public, unauthenticated: the only data exposed is aggregate weekly
  minutes and event counts, nothing player-identifying.
- `cache-control: no-store` — always live, matching "no scheduled job" (see
  §5 for why there isn't one yet).

Live output right now (verified, not asserted):

```json
{
  "metrics": [{
    "name": "weekly manual admin time on gameweek open/close and scoring",
    "baseline": 60, "current": null, "series": []
  }],
  "counter_metric": {
    "name": "scoring and classement accuracy must not decrease",
    "baseline": 0, "current": 0, "direction": "must not increase"
  }
}
```

## 4. The counter-metric has no automated signal — flagged, not hidden

"Scoring and classement accuracy must not decrease" has no telemetry event
that measures accuracy directly — nothing in the 8-event registry computes
"was this score correct." The `baseline: 0, current: 0` shown is **0 known
scoring errors**, sourced from the 118-test suite's deterministic
scoring/standings assertions (pre-release, not production traffic), not
from any live counter. The dashboard says this explicitly in the counter
card's note rather than implying a real-time accuracy measurement exists.
Closing this gap for real would mean building a reconciliation check
(computed standings vs. independently-verified match results) — out of
scope for this gate, and worth a line in future work.

## 5. Deploying it — three platform constraints found the hard way

Every one of these was found by actually deploying and testing, not by
reasoning about what should work:

1. **Supabase Edge Functions cannot serve HTML.** Documented, deliberate
   platform behavior: "`GET` requests that return `text/html` will be
   rewritten to `text/plain`." Confirmed by deploying
   `supabase/functions/dashboard` and observing `content-type: text/plain`
   in the live response despite explicitly setting `text/html`.
2. **Public Supabase Storage does the same to `.html` objects** — an
   XSS-prevention default, also confirmed live (uploaded
   `dashboard/index.html` to a public bucket, got `text/plain` back).
3. **GitHub Pages' "deploy from a branch" only accepts `/` or `/docs`** as
   the source path — `dashboard/` isn't a valid option, so this uses the
   Actions-based Pages deployment instead
   ([`.github/workflows/pages.yml`](../../.github/workflows/pages.yml)),
   uploading `dashboard/` directly as the Pages artifact.

Landed on **GitHub Pages** (confirmed with the user before enabling it on
the public repo — this wasn't assumed). It's a genuine static file, no
framework, no build step for the dashboard itself to run — deployed via
`git push` to `main`, the same mechanism as everything else in this repo.

**Also found by testing, not reasoning:** `curl` doesn't enforce CORS, so
the adapter looked fine under curl but the live dashboard — served from a
different origin (`lionelleboiteux.github.io` fetching
`dmytkubjxwwwkroutvdu.supabase.co`) — failed silently with no data at all
in a real browser. Caught by actually loading the page in Chrome (not just
API-testing the adapter) and fixed by adding CORS headers to
`dashboard-metrics`. Re-verified in-browser afterward: all cards render
with real (currently empty) data.

**Not built: a scheduled job writing the JSON to object storage**, which
`dashboard-guide.md` calls the better option ("the dashboard then has no
dependency on the app being up"). The live read-only endpoint used instead
is simpler and in-scope for this gate, but does mean the dashboard goes
dark if the API/database is down — an explicit, acceptable trade for now,
not an oversight.

**Known, harmless leftover:** an unused `dashboard` Storage bucket (from
the abandoned Storage-hosting attempt in point 2) is still live on the
project — Storage blocks direct SQL deletes on its tables (RLS-style) and
the CLI's experimental `storage rm` silently no-ops against this project,
so cleanup wasn't completed. Nothing references it; it costs nothing;
flagged here rather than pretending it isn't there.

**A second real bug this caught:** the migration that created that bucket
(`insert into storage.buckets ...`) was briefly committed as
`db/migrations/0003_create_dashboard_bucket.sql` — the same directory
`tests/` applies against a plain Testcontainers Postgres 16. `storage.*` is
Supabase-platform schema, not part of this app's own schema, and doesn't
exist there: `npm test` immediately went from 118/118 to 27 failing
(`relation "storage.buckets" does not exist`, SQLSTATE 42P01). Removed the
file — the bucket already existed live regardless, and `db/migrations/`
should only ever contain this app's own schema, never platform
housekeeping. 118/118 confirmed passing again before this gate closed.

## 6. What's live right now

- Dashboard: https://lionelleboiteux.github.io/pronos/
- Adapter: https://dmytkubjxwwwkroutvdu.supabase.co/functions/v1/dashboard-metrics
- Deploy mechanism for the dashboard: push to `main` → GitHub Actions
  (`pages.yml`) → GitHub Pages. For the adapter: `supabase functions deploy
  dashboard-metrics` (manual today; folding into `deploy.yml` is natural
  future work, not done this gate since the adapter doesn't change on every
  app release).
