/**
 * Deno/Supabase Edge Function entrypoint. Wire-format decoding only — every
 * routing, validation, and business decision lives in `handleRequest` and
 * the handlers it calls (src/api/server.ts and below), shared verbatim with
 * the Node entrypoint that tests/e2e run against. This file's only job is
 * translating a standard Fetch `Request`/`Response` into the same abstract
 * `Request` shape `handleRequest` already accepts, and supplying a Postgres
 * client that satisfies `QueryExecutor`.
 */
import { Pool } from 'postgres';
import { createRepository, type QueryExecutor } from '../../../src/db/repository.ts';
import { errorResponse } from '../../../src/api/errors.ts';
import { handleRequest, type Ctx, type Request as ApiRequest } from '../../../src/api/router.ts';
import { SUBMIT_RATE_LIMIT_PER_MINUTE, createRateLimiter } from '../../../src/api/rateLimit.ts';

const databaseUrl = Deno.env.get('SUPABASE_DB_URL') ?? Deno.env.get('DATABASE_URL');
if (!databaseUrl) throw new Error('SUPABASE_DB_URL (or DATABASE_URL) must be set.');
const adminToken = Deno.env.get('ADMIN_TOKEN');
if (!adminToken) throw new Error('ADMIN_TOKEN must be set.');

// deno-postgres, Supabase's own documented driver for raw SQL from Edge
// Functions (https://supabase.com/docs/guides/functions/connect-to-postgres)
// — a single-connection pool is what that example uses too; Edge Functions
// are stateless/short-lived so one connection per instance is the right size.
const pool = new Pool(databaseUrl, 1, true);

const queryExecutor: QueryExecutor = {
  async query(text, params = []) {
    const conn = await pool.connect();
    try {
      const result = await conn.queryObject(text, params);
      return { rows: result.rows as Record<string, unknown>[] };
    } finally {
      conn.release();
    }
  },
};

const ctx: Ctx = {
  repo: createRepository(queryExecutor),
  adminToken,
  rateLimiter: createRateLimiter({ max_requests: SUBMIT_RATE_LIMIT_PER_MINUTE, window_ms: 60_000 }),
  emailKeys: new Set(),
  adminResponses: new Map(),
};

// The frontend (frontend/index.html) and the dashboard are both served
// from a different origin (GitHub Pages) than this function — a browser
// fetch silently fails without CORS headers even though curl (no origin
// enforcement) can't catch that; see 11-dashboard.v1.md §5 for how this
// was found the first time. Public, no cookies/credentials involved.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, idempotency-key',
};

function toHeaderRecord(headers: Headers): ApiRequest['headers'] {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) out[key] = value;
  return out;
}

/**
 * The API process never sees the caller's raw TCP connection here — Supabase's
 * own edge gateway terminates it. `x-forwarded-for` is only safe to trust
 * because that gateway sets/appends it itself; the leftmost entry can still
 * be attacker-supplied (the same class of bug fixed in the Node server, see
 * 05-verification.v1.md §1), so this takes the *last* entry — the one the
 * gateway appended — never the first. `cf-connecting-ip` is preferred when
 * present since Cloudflare sets it directly from the true edge connection.
 * This has not yet been empirically confirmed against a live deployment
 * (see 10-pipeline.v1.md); until then treat rate-limit bypass via this path
 * as an open risk, not a closed one.
 */
function clientIpOf(headers: Headers): string {
  const cfConnectingIp = headers.get('cf-connecting-ip');
  if (cfConnectingIp) return cfConnectingIp;
  const forwardedFor = headers.get('x-forwarded-for');
  if (forwardedFor) {
    const hops = forwardedFor.split(',').map((h) => h.trim());
    return hops[hops.length - 1] || 'unknown';
  }
  return 'unknown';
}

async function readBody(req: globalThis.Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const raw = await req.text();
  if (raw.trim() === '') return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

  const url = new URL(req.url);
  // The path prefix this function is invoked under varies by how it's
  // reached: bare (local `deno run`), `/api/...` (via Kong, the function
  // slug), or `/functions/v1/api/...` (direct edge-runtime, e.g. `supabase
  // functions serve`). Every real route starts with `/v1`, so slicing from
  // the first `/v1` segment normalizes all three without hardcoding which
  // one is in front — the shared route table then matches plain /v1/...
  // paths exactly as the Node entrypoint does.
  const v1At = url.pathname.indexOf('/v1');
  const pathname = v1At === -1 ? url.pathname : url.pathname.slice(v1At);

  const body = await readBody(req);
  const result = body.ok
    ? await handleRequest(
        req.method,
        pathname,
        url.searchParams,
        {
          params: [],
          query: url.searchParams,
          headers: toHeaderRecord(req.headers),
          body: body.body,
          client_ip: clientIpOf(req.headers),
        },
        ctx,
      ).catch((err: unknown) =>
        errorResponse(500, 'INTERNAL_ERROR', (err as Error).message ?? 'An unexpected error occurred.'),
      )
    : errorResponse(400, 'VALIDATION_FAILED', 'Request body is not valid JSON.');

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: {
      'content-type': 'application/json',
      // Lets a rollback (or any deploy) be verified from the outside: which
      // code actually answered this request, not just "the deploy command
      // exited 0". Supabase injects DENO_DEPLOYMENT_ID per function version.
      'x-deployment-id': Deno.env.get('DENO_DEPLOYMENT_ID') ?? 'unknown',
      ...CORS_HEADERS,
      ...(('headers' in result ? result.headers : undefined) ?? {}),
    },
  });
});
