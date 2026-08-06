-- 0001_initial_schema.sql — initial expand-only migration (ADR-0003).
-- Creates the schema frozen in pdlc/jeu-des-pronos/contracts/db-schema.sql.
-- Expand-only: this migration adds tables, constraints and indexes and
-- drops nothing, so it is safe to apply with no PITR to fall back on.

create extension if not exists pgcrypto;

create table if not exists leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  logo_url text,
  external_id text,
  raw jsonb,
  -- { "fixture_source": {"adapter": "...", "fallback_adapter": "...", "params": {...}},
  --   "calendar": {"rule": "...", "params": {...}} } — AC-13.
  config jsonb not null default '{}',
  current_gameweek_id uuid, -- FK added below, after gameweeks exists
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (external_id)
);

create table if not exists seasons (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  name text not null,
  starts_at timestamptz,
  ends_at timestamptz,
  external_id text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (league_id, name),
  unique (league_id, external_id)
);

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  name text not null,
  code text not null,
  logo_url text,
  external_id text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (league_id, code),
  unique (league_id, name),
  unique (league_id, external_id)
);

-- Identity model (accepted risk, matches "no accounts" assumption in spec
-- section 9): pseudo IS the identity, globally unique. AC-10's "prefilled from
-- device" is a pure client-side (localStorage) convenience — it is NOT backed
-- by a server-side device token, so it is not modelled here. Two different
-- real people who type the exact same pseudo string become one player row;
-- this is a known consequence of "no login, free-text pseudo" and is a
-- different problem from AC-09's near-duplicate detection (which is about the
-- same person accidentally creating a second identity via a typo).
create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  pseudo text not null unique,
  email text unique, -- was: not null unique — AC-12 requires email optional
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists gameweeks (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references seasons(id) on delete cascade,
  league_id uuid not null references leagues(id) on delete cascade,
  number int not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  stage_name text,
  external_id text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (season_id, number),
  unique (league_id, external_id)
);

alter table leagues
  add constraint leagues_current_gameweek_id_fkey
  foreign key (current_gameweek_id) references gameweeks(id) on delete set null;

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references seasons(id) on delete cascade,
  league_id uuid not null references leagues(id) on delete cascade,
  gameweek_id uuid references gameweeks(id) on delete set null,
  home_team_id uuid not null references teams(id),
  away_team_id uuid not null references teams(id),
  starts_at timestamptz not null, -- the single source of truth for "locked" (AC-01/AC-02)
  external_id text,
  raw jsonb,
  status text not null default 'scheduled',
  home_team_score int,
  away_team_score int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_different_teams check (home_team_id <> away_team_id),
  unique (league_id, external_id)
);

create table if not exists predictions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players(id) on delete cascade,
  game_id uuid not null references games(id) on delete cascade,
  gameweek_id uuid not null references gameweeks(id) on delete cascade,
  season_id uuid not null references seasons(id) on delete cascade,
  league_id uuid not null references leagues(id) on delete cascade,
  pred_home_team_score int not null,
  pred_away_team_score int not null,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (player_id, game_id) -- backs upsert-on-resubmit, AC-11
);

create table if not exists prediction_scores (
  id uuid primary key default gen_random_uuid(),
  prediction_id uuid not null references predictions(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  game_id uuid not null references games(id) on delete cascade,
  gameweek_id uuid not null references gameweeks(id) on delete cascade,
  season_id uuid not null references seasons(id) on delete cascade,
  league_id uuid not null references leagues(id) on delete cascade,
  points int not null default 0,
  scoring_breakdown jsonb,
  calculated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (prediction_id)
);

create table if not exists league_gameweek_standings (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players(id) on delete cascade,
  league_id uuid not null references leagues(id) on delete cascade,
  season_id uuid not null references seasons(id) on delete cascade,
  gameweek_id uuid not null references gameweeks(id) on delete cascade,
  points int not null default 0,
  rank int,
  predictions_count int not null default 0,
  correct_results_count int not null default 0,
  exact_scores_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (player_id, league_id, season_id, gameweek_id)
);

create table if not exists overall_standings (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players(id) on delete cascade,
  season_id uuid not null references seasons(id) on delete cascade,
  points int not null default 0,
  rank int,
  predictions_count int not null default 0,
  correct_results_count int not null default 0,
  exact_scores_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (player_id, season_id)
);

-- AC-09: near-duplicate pseudos flagged together for weekly admin review;
-- neither submission is blocked or auto-merged.
create table if not exists duplicate_flags (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  gameweek_id uuid not null references gameweeks(id) on delete cascade,
  player_a_id uuid not null references players(id) on delete cascade,
  player_b_id uuid not null references players(id) on delete cascade,
  similarity_score numeric not null,
  status text not null default 'pending' check (status in ('pending', 'reviewed', 'dismissed')),
  reviewed_at timestamptz,
  reviewed_by text,
  created_at timestamptz not null default now(),
  unique (league_id, gameweek_id, player_a_id, player_b_id)
);

-- Append-only telemetry store — this is what John's dashboard and the success
-- metric ("weekly manual admin time", counter-metric "scoring/classement
-- accuracy") are computed from. See pdlc/jeu-des-pronos/spec-header.json for
-- the required event list and per-event fields.
create table if not exists telemetry_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'match_locked',
    'prediction_submitted',
    'prediction_rejected_late',
    'gameweek_opened',
    'gameweek_closed',
    'scoring_run_completed',
    'duplicate_flagged',
    'admin_manual_intervention'
  )),
  league_id uuid references leagues(id),
  gameweek_id uuid references gameweeks(id),
  game_id uuid references games(id),
  occurred_at timestamptz not null default now(),
  -- event-specific fields not common to all events, e.g. player_pseudo,
  -- similarity_score, duration_minutes_estimate, has_email. See openapi.yaml
  -- and 02-architecture.v1.md §5 for the exact shape per event_type.
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists telemetry_events_type_time_idx on telemetry_events (event_type, occurred_at);
create index if not exists telemetry_events_league_gw_idx on telemetry_events (league_id, gameweek_id);

-- Row Level Security — added at the red gate (NFR-RLS-01/02), because the
-- threat model (02-architecture.v1.md §7, Tampering) depends on it: "RLS
-- blocks public INSERT/UPDATE on predictions/games/etc. entirely, so there's
-- no PostgREST bypass" of the Edge Function's kickoff-time check. The
-- original architecture-gate schema omitted the actual RLS statements — a
-- real gap in a frozen artifact, caught by the red-gate test suite rather
-- than after release.
--
-- No policies are granted to `anon` or `authenticated` on any table below.
-- Enabling RLS with zero policies denies all access to those roles by
-- default; only Supabase's `service_role` key (used exclusively by Edge
-- Functions, which bypasses RLS entirely) can read or write these tables.
-- There is deliberately no direct PostgREST access path for the frontend —
-- every read and write goes through an Edge Function (02-architecture.v1.md
-- §5), so a locked-down-by-default table is the correct shape, not a gap to
-- fill in with public read policies later.
alter table leagues enable row level security;
alter table seasons enable row level security;
alter table teams enable row level security;
alter table players enable row level security;
alter table gameweeks enable row level security;
alter table games enable row level security;
alter table predictions enable row level security;
alter table prediction_scores enable row level security;
alter table league_gameweek_standings enable row level security;
alter table overall_standings enable row level security;
alter table duplicate_flags enable row level security;
alter table telemetry_events enable row level security;
