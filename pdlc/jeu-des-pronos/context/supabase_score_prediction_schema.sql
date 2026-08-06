
create extension if not exists pgcrypto;

create table if not exists leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  logo_url text,
  external_id text,
  raw jsonb,
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

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  pseudo text not null unique,
  email text not null unique,
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

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references seasons(id) on delete cascade,
  league_id uuid not null references leagues(id) on delete cascade,
  gameweek_id uuid references gameweeks(id) on delete set null,
  home_team_id uuid not null references teams(id),
  away_team_id uuid not null references teams(id),
  starts_at timestamptz not null,
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
  unique (player_id, game_id)
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
