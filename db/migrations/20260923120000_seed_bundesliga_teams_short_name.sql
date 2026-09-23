-- 20260923120000_seed_bundesliga_teams_short_name.sql — expand-only (ADR-0003).
-- Seeds short_name/display_code (added in 20260921134400) for Bundesliga's
-- 18 teams, same convention as 20260921134500's Ligue 1 seed. teams.name
-- values below were read directly from the live `teams` table
-- (league_id = the Bundesliga row in `leagues`) before writing this file —
-- not guessed.

update teams set short_name = 'Köln',           display_code = 'KOE' where name = '1. FC Köln'                and league_id = (select id from leagues where code = 'BL1');
update teams set short_name = 'Union Berlin',   display_code = 'FCU' where name = '1. FC Union Berlin'         and league_id = (select id from leagues where code = 'BL1');
update teams set short_name = 'Mainz',          display_code = 'M05' where name = '1. FSV Mainz 05'            and league_id = (select id from leagues where code = 'BL1');
update teams set short_name = 'Leverkusen',     display_code = 'B04' where name = 'Bayer 04 Leverkusen'        and league_id = (select id from leagues where code = 'BL1');
update teams set short_name = 'Dortmund',       display_code = 'BVB' where name = 'Borussia Dortmund'          and league_id = (select id from leagues where code = 'BL1');
update teams set short_name = 'Gladbach',       display_code = 'BMG' where name = 'Borussia Mönchengladbach'   and league_id = (select id from leagues where code = 'BL1');
update teams set short_name = 'Frankfurt',      display_code = 'SGE' where name = 'Eintracht Frankfurt'        and league_id = (select id from leagues where code = 'BL1');
update teams set short_name = 'Augsburg',       display_code = 'FCA' where name = 'FC Augsburg'                and league_id = (select id from leagues where code = 'BL1');
update teams set short_name = 'Bayern Munich',  display_code = 'FCB' where name = 'FC Bayern München'          and league_id = (select id from leagues where code = 'BL1');
update teams set short_name = 'Schalke',        display_code = 'S04' where name = 'FC Schalke 04'              and league_id = (select id from leagues where code = 'BL1');
update teams set short_name = 'Hamburg',        display_code = 'HSV' where name = 'Hamburger SV'               and league_id = (select id from leagues where code = 'BL1');
update teams set short_name = 'RB Leipzig',     display_code = 'RBL' where name = 'RB Leipzig'                 and league_id = (select id from leagues where code = 'BL1');
update teams set short_name = 'Freiburg',       display_code = 'SCF' where name = 'SC Freiburg'                and league_id = (select id from leagues where code = 'BL1');
update teams set short_name = 'Paderborn',      display_code = 'SCP' where name = 'SC Paderborn 07'            and league_id = (select id from leagues where code = 'BL1');
update teams set short_name = 'Elversberg',     display_code = 'ELV' where name = 'SV 07 Elversberg'           and league_id = (select id from leagues where code = 'BL1');
update teams set short_name = 'Werder Bremen',  display_code = 'SVW' where name = 'SV Werder Bremen'           and league_id = (select id from leagues where code = 'BL1');
update teams set short_name = 'Hoffenheim',     display_code = 'TSG' where name = 'TSG Hoffenheim'             and league_id = (select id from leagues where code = 'BL1');
update teams set short_name = 'Stuttgart',      display_code = 'VFB' where name = 'VfB Stuttgart'              and league_id = (select id from leagues where code = 'BL1');
