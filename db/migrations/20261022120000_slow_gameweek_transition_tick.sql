-- Every pg_net call to /v1/internal/tick is a metered Edge Function
-- invocation (free plan: 500k/month; the org went over in the Oct 2026
-- cycle). The per-minute schedule from 20260825090000 was ~1,440 a day for a
-- transition that only matters once per gameweek, so run it every 5 minutes.
-- Same exception-swallowing shape as that migration so plain Postgres (the
-- DB test suite) treats this as a no-op.

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
    '*/5 * * * *',
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
