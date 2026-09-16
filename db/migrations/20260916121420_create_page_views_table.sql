-- 20260916121420_create_page_views_table.sql — expand-only (ADR-0003).
-- Backs POST /v1/page-view: a first-party, server-side view counter for
-- every fantasy-coach.fr sibling site (pronos, DNP, compos, groupes), same
-- reasoning as arsene-cms's own article-view counter (built the same day
-- as this migration) — no cookie, no client-side tracker domain for a
-- blocker to catch, since the write lands on pronos's own already-trusted
-- backend, the same one fc-shared/feedback.js already posts to from every
-- sibling site. RLS enabled with no policies, matching every other table
-- here: reads/writes only ever happen via the Edge Function's own DB
-- connection, never PostgREST.

create table if not exists page_views (
  id         uuid primary key default gen_random_uuid(),
  project    text not null,
  view       text,
  created_at timestamptz not null default now()
);

-- Backs both the write path's own lookups and the weekly-aggregate report's
-- `group by project, date_trunc('week', created_at)`.
create index if not exists page_views_project_created_at_idx
  on page_views (project, created_at);

alter table page_views enable row level security;
