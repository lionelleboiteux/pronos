-- Verify-gate perf finding: the hottest read paths (getLeagueCurrentState,
-- getGameweekStandings, getOverallStandings in src/db/repository.ts) filter
-- on columns with no leading index, forcing a sequential scan whose cost
-- grows with total accumulated rows rather than "this gameweek's rows".
-- Not a measured problem yet (see 05-verification.v1.md) — cheap and
-- purely additive (ADR-0003 expand-only discipline), so added proactively
-- rather than waiting for multi-season history to make it one.

create index if not exists games_gameweek_id_idx on games (gameweek_id);
create index if not exists predictions_gameweek_id_idx on predictions (gameweek_id);
create index if not exists league_gameweek_standings_league_gw_idx
  on league_gameweek_standings (league_id, gameweek_id);
create index if not exists overall_standings_season_id_idx on overall_standings (season_id);
