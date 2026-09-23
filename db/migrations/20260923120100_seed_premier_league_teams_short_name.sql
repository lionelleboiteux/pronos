-- 20260923120100_seed_premier_league_teams_short_name.sql — expand-only (ADR-0003).
-- Seeds short_name/display_code (added in 20260921134400) for Premier
-- League's 20 teams, same convention as 20260921134500's Ligue 1 seed.
-- teams.name values below were read directly from the live `teams` table
-- (league_id = the Premier League row in `leagues`) before writing this
-- file — not guessed.

update teams set short_name = 'Arsenal',         display_code = 'ARS' where name = 'Arsenal'                    and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Aston Villa',     display_code = 'AVL' where name = 'Aston Villa'                and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Bournemouth',     display_code = 'BOU' where name = 'Bournemouth'                and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Brentford',       display_code = 'BRE' where name = 'Brentford'                  and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Brighton',        display_code = 'BHA' where name = 'Brighton and Hove Albion'   and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Chelsea',         display_code = 'CHE' where name = 'Chelsea'                    and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Coventry',        display_code = 'COV' where name = 'Coventry City'              and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Crystal Palace',  display_code = 'CRY' where name = 'Crystal Palace'             and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Everton',         display_code = 'EVE' where name = 'Everton'                    and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Fulham',          display_code = 'FUL' where name = 'Fulham'                     and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Hull City',       display_code = 'HUL' where name = 'Hull City'                  and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Ipswich',         display_code = 'IPS' where name = 'Ipswich Town'               and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Leeds',           display_code = 'LEE' where name = 'Leeds United'               and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Liverpool',       display_code = 'LIV' where name = 'Liverpool'                  and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Man City',        display_code = 'MCI' where name = 'Manchester City'            and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Man United',      display_code = 'MUN' where name = 'Manchester United'          and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Newcastle',       display_code = 'NEW' where name = 'Newcastle United'           and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Nott''m Forest',  display_code = 'NFO' where name = 'Nottingham Forest'          and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Sunderland',      display_code = 'SUN' where name = 'Sunderland'                 and league_id = (select id from leagues where code = 'PL');
update teams set short_name = 'Tottenham',       display_code = 'TOT' where name = 'Tottenham Hotspur'          and league_id = (select id from leagues where code = 'PL');
