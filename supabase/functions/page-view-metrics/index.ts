/**
 * Data adapter for `dashboard/page-views.html` — weekly page-view counts
 * per fantasy-coach.fr sibling site (`page_views`,
 * `20260916121420_create_page_views_table.sql`, written by every sibling's
 * `fc-shared/pageview.js`).
 *
 * A separate function from `dashboard-metrics`, not folded into it: that
 * one is a product-specific PDLC benefit-dashboard artifact for a
 * different metric entirely (weekly manual admin-minutes, scoring-run
 * counts) — conflating the two would mix unrelated concerns under one
 * response. Same shape otherwise (own minimal `Pool`, raw SQL, no
 * dependency on `src/db/repository.ts`'s full `createRepo` machinery,
 * matching `dashboard-metrics`'s own established lightweight-adapter
 * style), and the same public/unauthenticated reasoning: the only data
 * exposed is an aggregate weekly count per project, nothing
 * visitor-identifying — no cookie, IP, or any other client-side signal is
 * ever stored in `page_views` at all.
 */
import { Pool } from 'postgres';

const databaseUrl = Deno.env.get('SUPABASE_DB_URL') ?? Deno.env.get('DATABASE_URL');
if (!databaseUrl) throw new Error('SUPABASE_DB_URL (or DATABASE_URL) must be set.');

const pool = new Pool(databaseUrl, 1, true);

// Served to dashboard/page-views.html from GitHub Pages — a different
// origin, same reasoning as dashboard-metrics's own CORS_HEADERS: a
// browser fetch silently fails without this even though curl (no origin
// enforcement) can't catch that.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
};

type WeeklyPageViews = { project: string; week_start: string; views: number };

async function weeklyPageViews(): Promise<WeeklyPageViews[]> {
  const conn = await pool.connect();
  try {
    const result = await conn.queryObject<{ project: string; week_start: string; views: string }>(
      `select project,
              date_trunc('week', created_at)::date::text as week_start,
              count(*) as views
         from page_views
        group by project, week_start
        order by week_start, project`,
    );
    return result.rows.map((r) => ({ project: r.project, week_start: r.week_start, views: Number(r.views) }));
  } finally {
    conn.release();
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

  try {
    const weekly = await weeklyPageViews();
    const body = { generated_at: new Date().toISOString(), weekly };
    return Response.json(body, { headers: { 'cache-control': 'no-store', ...CORS_HEADERS } });
  } catch (err) {
    return Response.json(
      { error: 'page-view-metrics query failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: CORS_HEADERS },
    );
  }
});
