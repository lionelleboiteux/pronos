-- 20260923120300_seed_la_liga_teams_short_name.sql — expand-only (ADR-0003).
-- Seeds short_name/display_code (added in 20260921134400) for La Liga's 20
-- teams, same convention as 20260921134500's Ligue 1 seed. teams.name
-- values below were read directly from the live `teams` table
-- (league_id = the La Liga row in `leagues`) before writing this file —
-- not guessed.

update teams set short_name = 'Athletic Bilbao',       display_code = 'ATH' where name = 'Athletic Club'               and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Atlético Madrid',       display_code = 'ATM' where name = 'Atlético de Madrid'          and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Osasuna',               display_code = 'OSA' where name = 'CA Osasuna'                  and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Celta Vigo',            display_code = 'CEL' where name = 'Celta'                       and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Alavés',                display_code = 'ALA' where name = 'Deportivo Alavés'            and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Elche',                 display_code = 'ELC' where name = 'Elche CF'                    and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Barcelona',             display_code = 'BAR' where name = 'FC Barcelona'                and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Getafe',                display_code = 'GET' where name = 'Getafe CF'                   and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Levante',               display_code = 'LEV' where name = 'Levante UD'                  and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Málaga',                display_code = 'MAL' where name = 'Málaga CF'                   and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Racing Santander',      display_code = 'RAC' where name = 'R. Racing Club'              and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Rayo Vallecano',        display_code = 'RAY' where name = 'Rayo Vallecano'              and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Deportivo La Coruña',   display_code = 'DEP' where name = 'RC Deportivo'                and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Espanyol',              display_code = 'ESP' where name = 'RCD Espanyol de Barcelona'   and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Betis',                 display_code = 'BET' where name = 'Real Betis'                  and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Real Madrid',           display_code = 'RMA' where name = 'Real Madrid'                 and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Real Sociedad',         display_code = 'RSO' where name = 'Real Sociedad'               and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Sevilla',               display_code = 'SEV' where name = 'Sevilla FC'                  and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Valencia',              display_code = 'VAL' where name = 'Valencia CF'                 and league_id = (select id from leagues where code = 'LL');
update teams set short_name = 'Villarreal',            display_code = 'VIL' where name = 'Villarreal CF'               and league_id = (select id from leagues where code = 'LL');
