-- John's dashboard gate: hosts dashboard/index.html as a public Storage
-- object — a genuinely static file on the same free tier as the app,
-- no new infrastructure. Public because the only data it displays is
-- aggregate weekly admin-minutes and event counts (see
-- supabase/functions/dashboard-metrics), nothing player-identifying.
insert into storage.buckets (id, name, public)
values ('dashboard', 'dashboard', true)
on conflict (id) do nothing;
