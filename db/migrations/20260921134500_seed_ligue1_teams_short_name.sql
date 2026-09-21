-- 20260921134500_seed_ligue1_teams_short_name.sql — expand-only (ADR-0003).
-- Seeds short_name/display_code (added in 20260921134400) for Ligue 1's
-- 18 teams. teams.name values below were read directly from the live
-- `teams` table (league_id = the Ligue 1 row in `leagues`) before writing
-- this file — not guessed. short_name matches the exact strings already
-- used as TEAM_LOGOS/TEAM_COLORS map keys in DNP/compos/presentations
-- (space convention, e.g. "Paris SG" not "Paris-SG"). display_code is the
-- common fan/media abbreviation, not the existing ingestion-owned `code`
-- column's trigram (e.g. team `code` "MAR" vs this migration's OM).

update teams set short_name = 'Auxerre',    display_code = 'AJA' where name = 'AJ Auxerre'              and league_id = (select id from leagues where code = 'L1');
update teams set short_name = 'Angers',     display_code = 'SCO' where name = 'Angers SCO'              and league_id = (select id from leagues where code = 'L1');
update teams set short_name = 'Monaco',     display_code = 'ASM' where name = 'AS Monaco'                and league_id = (select id from leagues where code = 'L1');
update teams set short_name = 'Troyes',     display_code = 'TRO' where name = 'Estac Troyes'             and league_id = (select id from leagues where code = 'L1');
update teams set short_name = 'Lorient',    display_code = 'FCL' where name = 'FC Lorient'               and league_id = (select id from leagues where code = 'L1');
update teams set short_name = 'Le Havre',   display_code = 'HAC' where name = 'Havre Athletic Club'      and league_id = (select id from leagues where code = 'L1');
update teams set short_name = 'Le Mans',    display_code = 'LEM' where name = 'Le Mans FC'               and league_id = (select id from leagues where code = 'L1');
update teams set short_name = 'Lille',      display_code = 'LIL' where name = 'LOSC Lille'               and league_id = (select id from leagues where code = 'L1');
update teams set short_name = 'Nice',       display_code = 'NIC' where name = 'OGC Nice'                 and league_id = (select id from leagues where code = 'L1');
update teams set short_name = 'Marseille',  display_code = 'OM'  where name = 'Olympique de Marseille'   and league_id = (select id from leagues where code = 'L1');
update teams set short_name = 'Lyon',       display_code = 'OL'  where name = 'Olympique Lyonnais'       and league_id = (select id from leagues where code = 'L1');
update teams set short_name = 'Paris FC',   display_code = 'PFC' where name = 'Paris FC'                 and league_id = (select id from leagues where code = 'L1');
update teams set short_name = 'Paris SG',   display_code = 'PSG' where name = 'Paris Saint-Germain'      and league_id = (select id from leagues where code = 'L1');
update teams set short_name = 'Lens',       display_code = 'RCL' where name = 'RC Lens'                  and league_id = (select id from leagues where code = 'L1');
update teams set short_name = 'Strasbourg', display_code = 'RCS' where name = 'RC Strasbourg Alsace'     and league_id = (select id from leagues where code = 'L1');
update teams set short_name = 'Brest',      display_code = 'BRE' where name = 'Stade Brestois 29'        and league_id = (select id from leagues where code = 'L1');
update teams set short_name = 'Rennes',     display_code = 'REN' where name = 'Stade Rennais FC'         and league_id = (select id from leagues where code = 'L1');
update teams set short_name = 'Toulouse',   display_code = 'TFC' where name = 'Toulouse FC'              and league_id = (select id from leagues where code = 'L1');
