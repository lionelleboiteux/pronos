-- 0005_create_feedback_table.sql — expand-only (ADR-0003).
-- Backs POST /v1/feedback: a free-text box on the prediction page, no auth,
-- rate-limited the same way /v1/predictions is (NFR-RATE-01 pattern) since
-- it's the app's other unauthenticated write path. RLS enabled with no
-- policies, matching every other table — reads/writes only ever happen via
-- the Edge Function's own DB connection, never PostgREST.

create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  client_ip text,
  created_at timestamptz not null default now()
);

alter table feedback enable row level security;
