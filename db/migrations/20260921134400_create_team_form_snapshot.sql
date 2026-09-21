-- 20260921134400_create_team_form_snapshot.sql — expand-only (ADR-0003).
-- Backs GET /v1/teams/form: a per-team "last 5 league results" snapshot
-- (win/draw/loss), consumed by fc-shared's <fc-team-form> widget across
-- every fantasy-coach.fr sibling site. Recomputed by the ingest write path
-- (syncFixtures.ts), not queried live from `games` on every widget render
-- — the widget is fetched on every sibling page load, so this trades a
-- small write-side recompute (piggybacked on the existing hourly ingest
-- cron) for a cheap, single-row read. League matches only: cup/European
-- competitions have no data source anywhere in this schema, so
-- `games.league_id` already excludes them structurally.
--
-- short_name/display_code are deliberately separate, hand-curated columns
-- — NOT the existing ingestion-owned `code` column, which upsertFixture's
-- team-upsert path may still overwrite from raw source data. Any future
-- teams-upsert must exclude short_name/display_code from its
-- `on conflict do update set` list so a re-ingestion can never clobber
-- these. short_name is the same short/town name already hand-curated and
-- duplicated as TEAM_LOGOS/TEAM_COLORS map keys across DNP/compos/
-- presentations (e.g. "Marseille", "Paris SG") — this migration makes
-- pronos the canonical source going forward. display_code is a 2-3 letter
-- fan-recognizable abbreviation (e.g. "OM", "PSG"), distinct from the
-- existing `code` column's ingestion-sourced trigrams (e.g. "MAR", "PAS"),
-- used in the widget's hover tooltip.

alter table teams add column if not exists short_name text;
alter table teams add column if not exists display_code text;

create unique index if not exists teams_league_short_name_idx
  on teams (league_id, short_name) where short_name is not null;
create unique index if not exists teams_league_display_code_idx
  on teams (league_id, display_code) where display_code is not null;

create table if not exists team_form_snapshot (
  team_id    uuid primary key references teams(id) on delete cascade,
  league_id  uuid not null references leagues(id) on delete cascade,
  -- oldest -> newest, at most 5 entries:
  -- [{ "game_id", "opponent_name", "opponent_short_name", "opponent_code",
  --    "is_home", "team_score", "opponent_score",
  --    "result": "W"|"D"|"L", "starts_at" }]
  results    jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

alter table team_form_snapshot enable row level security;
-- no policies: read/write only via the Edge Function's own DB connection,
-- same as feedback/page_views.
