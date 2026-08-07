-- Read-only admin view: "who predicted what" across every league/gameweek,
-- browsable directly in Supabase Studio's Table Editor (under Views) or the
-- SQL Editor with `select * from predictions_admin`. No new tables, no
-- new API surface — this is not exposed to players; it exists for Lio.
--
-- security_invoker = true is deliberate, not decorative: without it, a view
-- executes with its *owner's* privileges (the migration role, which
-- bypasses RLS), so it would silently leak every player's picks for
-- still-open matches through anon/authenticated if this schema is ever
-- opened up to the Data API later. With it, the view respects the
-- underlying tables' RLS for whoever queries it — currently service_role
-- only, matching every other table.
create view predictions_admin
with (security_invoker = true)
as
select
  l.code as league_code,
  l.name as league_name,
  gw.number as gameweek_number,
  p.pseudo,
  ht.name as home_team,
  at.name as away_team,
  pr.pred_home_team_score as predicted_home_score,
  pr.pred_away_team_score as predicted_away_score,
  g.home_team_score as actual_home_score,
  g.away_team_score as actual_away_score,
  g.starts_at as match_starts_at,
  g.status as match_status,
  pr.submitted_at,
  pr.updated_at
from predictions pr
join players p on p.id = pr.player_id
join games g on g.id = pr.game_id
join teams ht on ht.id = g.home_team_id
join teams at on at.id = g.away_team_id
join leagues l on l.id = pr.league_id
join gameweeks gw on gw.id = pr.gameweek_id
order by l.name, gw.number, g.starts_at, p.pseudo;
