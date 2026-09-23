-- 20260923120200_seed_serie_a_teams_short_name.sql — expand-only (ADR-0003).
-- Seeds short_name/display_code (added in 20260921134400) for Serie A's 20
-- teams, same convention as 20260921134500's Ligue 1 seed. teams.name
-- values below were read directly from the live `teams` table
-- (league_id = the Serie A row in `leagues`) before writing this file —
-- not guessed. Most Serie A team names are already their short form, so
-- short_name equals name for most rows here.

update teams set short_name = 'Atalanta',   display_code = 'ATA' where name = 'Atalanta'   and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Bologna',    display_code = 'BOL' where name = 'Bologna'    and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Cagliari',   display_code = 'CAG' where name = 'Cagliari'   and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Como',       display_code = 'COM' where name = 'Como'       and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Fiorentina', display_code = 'FIO' where name = 'Fiorentina' and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Frosinone',  display_code = 'FRO' where name = 'Frosinone'  and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Genoa',      display_code = 'GEN' where name = 'Genoa'      and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Inter',      display_code = 'INT' where name = 'Inter'      and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Juventus',   display_code = 'JUV' where name = 'Juventus'   and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Lazio',      display_code = 'LAZ' where name = 'Lazio'      and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Lecce',      display_code = 'LEC' where name = 'Lecce'      and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Milan',      display_code = 'MIL' where name = 'Milan'      and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Monza',      display_code = 'MON' where name = 'Monza'      and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Napoli',     display_code = 'NAP' where name = 'Napoli'     and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Parma',      display_code = 'PAR' where name = 'Parma'      and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Roma',       display_code = 'ROM' where name = 'Roma'       and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Sassuolo',   display_code = 'SAS' where name = 'Sassuolo'   and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Torino',     display_code = 'TOR' where name = 'Torino'     and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Udinese',    display_code = 'UDI' where name = 'Udinese'    and league_id = (select id from leagues where code = 'SA');
update teams set short_name = 'Venezia',    display_code = 'VEN' where name = 'Venezia'    and league_id = (select id from leagues where code = 'SA');
