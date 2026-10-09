/**
 * Shared Postgres access for the Edge Functions. Two things keep this from
 * exhausting Postgres connection slots (max_connections is only 60 on this
 * compute, shared with PostgREST, pg_cron, realtime...):
 *
 *  1. Prefer the Supavisor transaction pooler (DB_POOLER_URL, port 6543) over
 *     SUPABASE_DB_URL, which is a *direct* connection. Every warm isolate used
 *     to pin one direct slot for its whole lifetime, across three functions.
 *  2. Even on a direct URL, the connection is closed after a short idle period
 *     instead of being held for the isolate's lifetime.
 */
import { Pool } from 'postgres';

const IDLE_CLOSE_MS = 5_000;

const databaseUrl =
  Deno.env.get('DB_POOLER_URL') ?? Deno.env.get('SUPABASE_DB_URL') ?? Deno.env.get('DATABASE_URL');
if (!databaseUrl) throw new Error('DB_POOLER_URL, SUPABASE_DB_URL or DATABASE_URL must be set.');

let pool: Pool | null = null;
let inFlight = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (inFlight > 0 || !pool) return;
    const closing = pool;
    pool = null;
    closing.end().catch(() => {});
  }, IDLE_CLOSE_MS);
}

export async function query(
  text: string,
  params: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[] }> {
  clearTimeout(idleTimer);
  pool ??= new Pool(databaseUrl, 1, true);
  inFlight++;
  try {
    const conn = await pool.connect();
    try {
      const result = await conn.queryObject(text, params as never[]);
      return { rows: result.rows as Record<string, unknown>[] };
    } finally {
      conn.release();
    }
  } finally {
    inFlight--;
    scheduleIdleClose();
  }
}

/** True when Postgres/Supavisor refused the connection for lack of slots. */
export function isPoolExhausted(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return /remaining connection slots|too many (clients|connections)|max clients reached|MaxClientsInSessionMode/i.test(
    msg,
  );
}
