-- 20261112100000_fix_leverkusen_logo_url.sql — data fix, expand-only (ADR-0003).
-- Bayer 04 Leverkusen's logo_url pointed at bundesliga-reisefuehrer.de, which
-- now returns 404, so the crest fell back to an initials badge in the mobile
-- app. Point it at Wikipedia's PNG rendition of the club's SVG crest instead
-- (a PNG, not the raw .svg, so it also renders in React Native and in email
-- clients). The ingest never writes teams.logo_url, so this won't be reverted.

update teams
   set logo_url = 'https://upload.wikimedia.org/wikipedia/en/thumb/5/59/Bayer_04_Leverkusen_logo.svg/330px-Bayer_04_Leverkusen_logo.svg.png'
 where name = 'Bayer 04 Leverkusen'
   and league_id = (select id from leagues where code = 'BL1');
