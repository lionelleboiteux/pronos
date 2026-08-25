-- Wires pg_cron/pg_net to POST /v1/internal/tick (src/api/tick.ts), the
-- production entry point this project's own docs (README "Current Status",
-- docs/architecture.md, openapi.yaml's override-endpoint description) have
-- long documented as missing: `gameweekTransition.tick()` has existed as a
-- correct, unit-tested pure function since the initial build, but nothing
-- ever called it on a schedule, so a league's current gameweek never closed
-- or advanced no matter how long its last match had kicked off.
--
-- Every statement below is wrapped in an exception-swallowing DO block
-- because pg_cron/pg_net/Vault only exist on the managed Supabase Postgres
-- this runs against in production. The DB test suite (tests/support/pg.ts)
-- applies every file in this directory verbatim to a plain
-- `postgres:16-alpine` Testcontainer that has none of them — this file must
-- stay a harmless no-op there rather than fail every db test.
--
-- ONE MANUAL STEP THIS MIGRATION CANNOT DO FOR YOU: a real bearer token
-- can't be committed to git, so before this job's first call can succeed,
-- run once from the Supabase SQL editor (using the same value already held
-- as the `INGEST_TOKEN` Edge Function secret):
--   select vault.create_secret('<the INGEST_TOKEN value>', 'tick_token');
-- Until that secret exists, the scheduled call 401s and this stays a silent
-- no-op — check `select * from net._http_response order by id desc limit 5;`
-- if a gameweek stays stuck after this deploys.

do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'pg_cron unavailable in this Postgres instance; skipping (expected outside Supabase).';
end $$;

do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net unavailable in this Postgres instance; skipping (expected outside Supabase).';
end $$;

-- Re-running this migration (or a future one that needs to replace the job)
-- must not error on "job already exists" — unschedule first, ignoring the
-- "no such job" error on a first run.
do $$
begin
  perform cron.unschedule('gameweek-transition-tick');
exception when others then
  null;
end $$;

do $$
begin
  perform cron.schedule(
    'gameweek-transition-tick',
    '* * * * *',
    $cron$
    select net.http_post(
      url := 'https://dmytkubjxwwwkroutvdu.supabase.co/functions/v1/api/v1/internal/tick',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets where name = 'tick_token'
        )
      ),
      body := '{}'::jsonb
    );
    $cron$
  );
exception when others then
  raise notice 'pg_cron/pg_net/Vault unavailable in this Postgres instance; skipping (expected outside Supabase).';
end $$;
