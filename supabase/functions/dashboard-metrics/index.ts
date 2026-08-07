/**
 * Data adapter for the benefit dashboard (john-dashboard gate). The one
 * job of this function is to turn telemetry_events into the single JSON
 * document dashboard/index.html fetches — see
 * pdlc/jeu-des-pronos/11-dashboard.v1.md for the full metric definitions
 * and why the baseline/counter-metric are what they are.
 *
 * Deliberately public/unauthenticated: the only data exposed is aggregate
 * weekly admin-minutes and event counts, nothing player-identifying.
 */
import { Pool } from 'postgres';

const databaseUrl = Deno.env.get('SUPABASE_DB_URL') ?? Deno.env.get('DATABASE_URL');
if (!databaseUrl) throw new Error('SUPABASE_DB_URL (or DATABASE_URL) must be set.');

const pool = new Pool(databaseUrl, 1, true);

type WeeklyAdminMinutes = { week_start: string; total_minutes: number };

async function weeklyAdminMinutes(): Promise<WeeklyAdminMinutes[]> {
  const conn = await pool.connect();
  try {
    const result = await conn.queryObject<{ week_start: string; total_minutes: string }>(
      `select date_trunc('week', occurred_at)::date::text as week_start,
              sum((payload->>'duration_minutes_estimate')::numeric) as total_minutes
         from telemetry_events
        where event_type = 'admin_manual_intervention'
        group by week_start
        order by week_start`,
    );
    return result.rows.map((r) => ({ week_start: r.week_start, total_minutes: Number(r.total_minutes) }));
  } finally {
    conn.release();
  }
}

async function scoringRunCount(): Promise<number> {
  const conn = await pool.connect();
  try {
    const result = await conn.queryObject<{ count: string }>(
      `select count(*)::text as count from telemetry_events where event_type = 'scoring_run_completed'`,
    );
    return Number(result.rows[0]?.count ?? '0');
  } finally {
    conn.release();
  }
}

Deno.serve(async () => {
  try {
    const [weekly, scoringRuns] = await Promise.all([weeklyAdminMinutes(), scoringRunCount()]);
    const series = weekly.map((w) => ({ date: w.week_start, value: w.total_minutes }));
    const current = series.length > 0 ? series[series.length - 1].value : null;

    const body = {
      generated_at: new Date().toISOString(),
      idea: 'jeu-des-pronos',
      released_at: '2026-08-07',
      metrics: [
        {
          name: 'weekly manual admin time on gameweek open/close and scoring',
          unit: 'minutes per week',
          // Self-reported, from the adopt-gate spec: the pre-automation
          // process (9 spreadsheets + Make.com scenarios) was never
          // instrumented, so this cannot be independently re-derived —
          // it is quoted, not measured. See 11-dashboard.v1.md §2.
          baseline: 60,
          baseline_captured: '2026-08-07 (self-reported estimate, pre-automation; not from telemetry)',
          target: 5,
          target_direction: 'down',
          by_when: 'mid/late August 2026, before the new season starts',
          current,
          series,
        },
      ],
      counter_metric: {
        name: 'scoring and classement accuracy must not decrease',
        // No automated accuracy telemetry exists (see 11-dashboard.v1.md
        // §4) — this is a known gap, not a hidden one. These counts are
        // from the pre-release test suite, not production traffic.
        baseline: 0,
        current: 0,
        direction: 'must not increase',
        note:
          'No automated accuracy signal exists in production yet. baseline/current = 0 known scoring errors, verified by the 118-test suite (deterministic, pre-release), not by live telemetry. scoring_run_completed has fired ' +
          scoringRuns +
          ' time(s) in production so far — an activity count, not an accuracy measure.',
      },
    };

    return Response.json(body, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return Response.json(
      { error: 'dashboard-metrics query failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
