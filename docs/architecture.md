# Architecture

## Container Diagram

This system is built on Supabase's managed Postgres and Edge Functions, with scheduled tasks running directly inside Postgres via pg_cron.

```mermaid
graph TB
    Player["[Player's Browser]<br/>Static HTML form<br/>localStorage for pseudo memory"]
    Admin["[Admin Browser]<br/>Duplicate review view<br/>gameweek override console"]
    
    Edge["[Edge Functions]<br/>Supabase<br/><br/>All write authority<br/>Kickoff-time lock check<br/>Telemetry emission<br/>Rate limiting"]
    
    Postgres["[Postgres Database]<br/>Supabase Free<br/><br/>predictions, games, gameweeks<br/>leagues, seasons, teams, players<br/>standings (materialized views)<br/>telemetry_events<br/>duplicate_flags<br/>RLS: anon/authenticated = no access<br/>service_role = only via Edge Functions"]
    
    Cron["[pg_cron Scheduler]<br/>PLANNED — not yet wired<br/><br/>Intended minute-level jobs:<br/>lock matches, open/close gameweeks,<br/>weekly duplicate scan<br/>— the domain logic for these exists<br/>and is tested, but no pg_cron job<br/>definition calls it yet"]
    
    Fixtures["[Fixture Sources]<br/>NOT YET BUILT<br/><br/>Planned: per-league scraper<br/>or fallback API, populating<br/>games.home_team_score /<br/>away_team_score<br/>— separate slice, own red gate,<br/>no code exists in this repo"]
    
    Player -->|POST /v1/predictions| Edge
    Player -->|GET /v1/leagues| Edge
    Player -->|GET /v1/leagues/{id}/current| Edge
    Player -->|GET standings| Edge
    
    Admin -->|GET /v1/admin/duplicate-flags| Edge
    Admin -->|PATCH /v1/admin/duplicate-flags/{id}| Edge
    Admin -->|POST /v1/admin/gameweeks/{id}/override| Edge
    
    Edge -->|Read/write predictions,<br/>gameweeks, players,<br/>manage lock state| Postgres
    
    Cron -.->|planned: run scheduled<br/>tasks inside Postgres| Postgres
    Cron -.->|planned: INSERT into<br/>telemetry_events| Postgres
    Cron -.->|planned: fetch fixtures| Fixtures
    Fixtures -.->|planned: update match<br/>scores in games table| Postgres
    
    style Edge fill:#ffd700
    style Postgres fill:#4a90e2
    style Cron fill:#dddddd,stroke-dasharray: 5 5
    style Fixtures fill:#dddddd,stroke-dasharray: 5 5
    style Player fill:#e8e8e8
    style Admin fill:#e8e8e8
```

Dashed nodes/edges above (`Cron`, `Fixtures`) are architecturally planned but not yet
built — see "Telemetry" and the Verify-gate evidence linked below for exactly
which pieces exist as tested logic versus running code today.

## Design Rationale

**Why Supabase Postgres + Edge Functions + pg_cron?**

This was chosen over three alternatives after evaluating cost, scheduling precision, and operational safety:

1. **Cloudflare Workers/D1/Cron Triggers** — Free-tier headroom is excellent, but Cron Triggers cap at 5 per account (solvable, but a constraint), and D1's Time Travel (whole-DB restore) leaves no per-record recovery path.

2. **Render + Postgres + GitHub Actions cron** — Render's free tier is a sleeping web container; GitHub Actions cron has 10-30 minute drift; together they mean gameweek-close signals arrive 30-60 seconds late, directly risking acceptance criteria AC-06/07 (reliable, timely gameweek transitions).

3. **Airtable** — Free plan caps records at 1,000/base; a season across 3 leagues is ~1,000 match rows before a single prediction exists. Requires upgrade ($20+/month), and direct grid editing bypasses the API layer, defeating the admin-time telemetry the project exists to measure.

**Supabase wins because:**
- Scheduling runs *at the database*, not on a separate container — pg_cron's minute-level granularity means gameweek-close signals fire within the window they're supposed to, no cold starts, no external wake-up mechanism.
- Edge Functions are stateless, versionable (git), and rollback-friendly (one git tag + deploy).
- Free tier survives both 1x and 10x load on every meter (Edge invocations, storage, compute).
- The schema was pre-designed by Lio (Postgres-shaped, ready to go).

**The trade-off:** Supabase Free has no backups or point-in-time recovery (PITR is $100/month). Mitigated by:
- ADR-0003: Every schema change is expand-only (add columns/tables, never drop in the same release). This makes every release reversible by reverting code; only the expansion step is irreversible.
- Pre-migration dumps (manual `pg_dump`, stored outside Supabase) before any drop/alter is applied.

## API Surface

All endpoints live under `/v1` (versioning strategy: breaking changes → `/v2`, non-breaking changes stay in `/v1`):

**Public (no auth):**
- `GET /v1/leagues` — List configured leagues
- `GET /v1/leagues/{id}/current` — League's open gameweek, matches, lock state (computed at request time, never cached)
- `POST /v1/predictions` — Submit or overwrite a player's prediction; rejects if match has kicked off (server-side authority)
- `GET /v1/leagues/{id}/gameweeks/{id}/standings` — Paginated per-gameweek classement
- `GET /v1/leagues/{id}/seasons/{id}/standings/overall` — Season-long standings

**Admin (Supabase Auth bearer JWT):**
- `GET /v1/admin/duplicate-flags` — List near-duplicate pseudos (pending/reviewed/dismissed)
- `PATCH /v1/admin/duplicate-flags/{id}` — Mark a flag reviewed or dismissed (never merges players)
- `POST /v1/admin/gameweeks/{id}/override` — Manually open, close, or re-score a gameweek; includes `duration_minutes_estimate` for the success metric

Error envelope on all operations: `{ error: { code, message, details, request_id } }` with a closed code enum (VALIDATION_FAILED, MATCH_LOCKED, NOT_FOUND, UNAUTHORIZED, CONFLICT, INTERNAL_ERROR).

## Key Constraints

**No accounts, no passwords:** Players are identified by a free-text pseudo (max 60 characters). Browser-side `localStorage` remembers the last-used pseudo so returning players don't have to retype (AC-10); the field remains editable. This is entirely client-side; the server never sees or stores device tokens.

**Rate limiting:** `POST /v1/predictions` is limited to 10 requests per minute per client IP (per NFR-RATE-01). Uses real TCP peer (`req.socket.remoteAddress`), not client-supplied headers (mitigates header spoofing). Admin bearer token is exempt so Schemathesis's fuzzing doesn't get rate-limited.

**Lock is authoritative and live:** Whether a match is "locked" is *never* a stored flag; it is computed as `games.starts_at <= now()` at request time. This means a stale browser page cannot trick the API, and the frontend's grey-out (AC-02) is purely cosmetic and must not be trusted as the authority.

**RLS blocks public writes:** Every table is protected by row-level security. `anon` and `authenticated` roles get zero policies; only `service_role` (used exclusively by Edge Functions) can bypass RLS. This prevents any direct PostgREST call from a player bypassing the API layer's lock check.

**Idempotency:** `POST /v1/predictions` is idempotent via the DB's `unique (player_id, game_id)` constraint — resubmitting the same prediction before lock converges on one row, never two. Optional `Idempotency-Key` additionally dedupes email receipts (AC-12). `POST /v1/admin/gameweeks/{id}/override` requires `Idempotency-Key` since its side effects (telemetry insert, rescoring) are not safe to repeat silently.

## Telemetry

All required events land in `telemetry_events` table:

1. `prediction_submitted` — A player's prediction accepted
2. `prediction_rejected_late` — A submission rejected (match already kicked off)
3. `match_locked` — A match's kickoff time has passed (logic correct, cron entry pending)
4. `gameweek_opened` — A new gameweek became open (logic correct, cron entry pending)
5. `gameweek_closed` — A gameweek closed to new submissions (logic correct, cron entry pending)
6. `scoring_run_completed` — Morning-after scoring run finished; includes `players_scored_count` as a sanity signal
7. `duplicate_flagged` — Weekly scan found near-duplicate pseudos (logic correct, cron entry pending)
8. `admin_manual_intervention` — Lio manually opened/closed/re-scored; includes `duration_minutes_estimate` (directly inputs success metric)

The weekly admin time metric is derived by summing `admin_manual_intervention.duration_minutes_estimate` per week. A dead-man's-switch (alerting if expected events don't appear within their windows) is the only production observability this build provides; Supabase gives no native job-failure alerts.

## Extensibility

**Adding a 4th league:** Insert a row into the `leagues` table with the league's name, code, logo URL, and a `config` column specifying the fixture source and calendar rule. No code changes, no form changes, no schema changes — the same `POST /v1/predictions` endpoint, the same `POST /v1/admin/gameweeks/{id}/override` override handler, and the gameweek-transition logic (`src/domain/gameweekTransition.ts`, tested but not yet cron-wired — see Telemetry above) all work per-league without modification (see AC-13, ADR-0002).

## References

- Architecture decision records: [`pdlc/jeu-des-pronos/adr/`](../pdlc/jeu-des-pronos/adr/)
- Full architecture analysis: [`pdlc/jeu-des-pronos/02-architecture.v1.md`](../pdlc/jeu-des-pronos/02-architecture.v1.md)
- API contract: [`pdlc/jeu-des-pronos/contracts/openapi.yaml`](../pdlc/jeu-des-pronos/contracts/openapi.yaml)
- Test matrix: [`pdlc/jeu-des-pronos/traceability.md`](../pdlc/jeu-des-pronos/traceability.md)
