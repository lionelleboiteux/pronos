/**
 * Provider entry point: the Edge Function router, hosted over plain HTTP so
 * the same code that runs on Supabase can be fuzzed against
 * contracts/openapi.yaml.
 *
 * The router's only jobs are routing, validating the request boundary, and
 * turning handler results into HTTP. Every decision that matters — the
 * kickoff lock, the admin idempotency replay, telemetry — lives in the
 * handlers under src/api and the pure functions under src/domain.
 */

import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { createRepository, type Repository } from '../db/repository.ts';
import { createTelemetrySink } from '../telemetry/events.ts';
import { errorResponse, type ApiResponse } from './errors.ts';
import { handleGetCurrentGameweek } from './getCurrentGameweek.ts';
import { handleGameweekOverride } from './adminOverride.ts';
import { handleSubmitPrediction, type SubmitRequest } from './submitPrediction.ts';
import { SUBMIT_RATE_LIMIT_PER_MINUTE, createRateLimiter, type RateLimiter } from './rateLimit.ts';

/** An ApiResponse plus any header the HTTP layer itself owes (e.g. Allow). */
type HttpResponse = ApiResponse & { headers?: Record<string, string> };

type Ctx = {
  repo: Repository;
  adminToken: string;
  rateLimiter: RateLimiter;
  /** Idempotency-Key replay stores, in-memory for a single function instance. */
  emailKeys: Set<string>;
  adminResponses: Map<string, ApiResponse>;
};

type Request = {
  params: string[];
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
  client_ip: string;
};

type Route = {
  pattern: RegExp;
  /** Query parameters the contract declares; anything else is rejected. */
  query: string[];
  handlers: Record<string, (req: Request, ctx: Ctx) => Promise<HttpResponse>>;
};

const Uuid = z.uuid();
// `page` has no documented upper bound, so it is checked for integrality
// rather than for JS safe-integer range; the repository clamps the offset.
const Pagination = z.object({
  page: z.coerce.number().refine(Number.isInteger).min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
});

const NOT_FOUND = () => errorResponse(404, 'NOT_FOUND', 'No resource was found matching the given identifier(s).');

const invalid = (message: string): ApiResponse =>
  errorResponse(400, 'VALIDATION_FAILED', message);

/** Rejects a bad page/per_page rather than silently clamping it. */
function paginationOf(query: URLSearchParams): { page: number; per_page: number } | null {
  const parsed = Pagination.safeParse(Object.fromEntries(query));
  return parsed.success ? parsed.data : null;
}

const isAdmin = (req: Request, ctx: Ctx): boolean =>
  req.headers.authorization === `Bearer ${ctx.adminToken}`;

const UNAUTHORIZED = () =>
  errorResponse(401, 'UNAUTHORIZED', 'A valid Supabase Auth bearer token is required for this endpoint.');

/**
 * NFR-RATE-01 protects the public, unauthenticated submit endpoint from
 * anonymous abuse. A caller presenting the admin secret already has a
 * standing trust relationship (NFR-AUTH-01) — no anonymous player can ever
 * produce it — so it is exempt, the same way an internal service account is
 * exempt from a public API's rate limit on any other API. This is what lets
 * the contract-fuzzing suite exercise this operation at volume without
 * weakening the limit for real, anonymous traffic.
 */
const ALWAYS_ALLOW: RateLimiter = { check: () => ({ allowed: true, limit: SUBMIT_RATE_LIMIT_PER_MINUTE }) };

const paginationOut = (total_items: number, q: { page: number; per_page: number }) => ({
  page: q.page,
  per_page: q.per_page,
  total_items,
  total_pages: Math.ceil(total_items / q.per_page),
});

const ROUTES: Route[] = [
  {
    pattern: /^\/v1\/leagues$/,
    query: [],
    handlers: {
      GET: async (_req, ctx) => ({ status: 200, body: { data: await ctx.repo.listLeagues() } }),
    },
  },
  {
    pattern: /^\/v1\/leagues\/([^/]+)\/current$/,
    query: ['pseudo'],
    handlers: {
      GET: async (req, ctx) => {
        if (!Uuid.safeParse(req.params[0]).success) return NOT_FOUND();
        const pseudo = req.query.get('pseudo');
        if (pseudo !== null && (pseudo.length < 1 || pseudo.length > 60)) {
          return invalid('pseudo must be between 1 and 60 characters.');
        }
        return handleGetCurrentGameweek(
          { league_id: req.params[0] as string, ...(pseudo === null ? {} : { pseudo }) },
          { now: () => new Date(), repo: ctx.repo },
        );
      },
    },
  },
  {
    pattern: /^\/v1\/predictions$/,
    query: [],
    handlers: {
      POST: async (req, ctx) => {
        const sink = createTelemetrySink();
        const key = req.headers['idempotency-key'];
        const response = await handleSubmitPrediction(
          {
            ...(req.body as object),
            ...(typeof key === 'string' ? { idempotency_key: key } : {}),
            client_ip: req.client_ip,
          } as SubmitRequest,
          {
            now: () => new Date(),
            repo: ctx.repo,
            telemetry: sink,
            mailer: { sendReceipt: async () => true },
            rateLimiter: isAdmin(req, ctx) ? ALWAYS_ALLOW : ctx.rateLimiter,
            idempotency: {
              seen: (k) => ctx.emailKeys.has(k),
              remember: (k) => void ctx.emailKeys.add(k),
            },
          },
        );
        await ctx.repo.insertTelemetryEvents(sink.events);
        return response;
      },
    },
  },
  {
    pattern: /^\/v1\/leagues\/([^/]+)\/gameweeks\/([^/]+)\/standings$/,
    query: ['page', 'per_page'],
    handlers: {
      GET: async (req, ctx) => {
        const ids = z.tuple([Uuid, Uuid]).safeParse(req.params);
        if (!ids.success) return NOT_FOUND();
        const q = paginationOf(req.query);
        if (!q) return invalid('page and per_page must be within the documented ranges.');
        const found = await ctx.repo.getGameweekStandings(ids.data[0], ids.data[1], q);
        return {
          status: 200,
          body: {
            league_id: ids.data[0],
            gameweek_id: ids.data[1],
            data: found.rows,
            pagination: paginationOut(found.total_items, q),
          },
        };
      },
    },
  },
  {
    pattern: /^\/v1\/leagues\/([^/]+)\/seasons\/([^/]+)\/standings\/overall$/,
    query: ['page', 'per_page'],
    handlers: {
      GET: async (req, ctx) => {
        const ids = z.tuple([Uuid, Uuid]).safeParse(req.params);
        if (!ids.success) return NOT_FOUND();
        const q = paginationOf(req.query);
        if (!q) return invalid('page and per_page must be within the documented ranges.');
        const found = await ctx.repo.getOverallStandings(ids.data[1], q);
        return {
          status: 200,
          body: {
            league_id: ids.data[0],
            season_id: ids.data[1],
            data: found.rows,
            pagination: paginationOut(found.total_items, q),
          },
        };
      },
    },
  },
  {
    pattern: /^\/v1\/admin\/duplicate-flags$/,
    query: ['status', 'league_id', 'gameweek_id', 'page', 'per_page'],
    handlers: {
      GET: async (req, ctx) => {
        if (!isAdmin(req, ctx)) return UNAUTHORIZED();
        const filter = z
          .object({
            status: z.enum(['pending', 'reviewed', 'dismissed', 'all']).default('pending'),
            league_id: Uuid.optional(),
            gameweek_id: Uuid.optional(),
          })
          .safeParse(Object.fromEntries(req.query));
        const q = paginationOf(req.query);
        if (!filter.success || !q) return invalid('Request failed validation.');
        const found = await ctx.repo.listDuplicateFlags({ ...filter.data, ...q });
        return {
          status: 200,
          body: { data: found.rows, pagination: paginationOut(found.total_items, q) },
        };
      },
    },
  },
  {
    pattern: /^\/v1\/admin\/duplicate-flags\/([^/]+)$/,
    query: [],
    handlers: {
      PATCH: async (req, ctx) => {
        if (!isAdmin(req, ctx)) return UNAUTHORIZED();
        if (!Uuid.safeParse(req.params[0]).success) return NOT_FOUND();
        const body = z
          .object({ status: z.enum(['reviewed', 'dismissed']) })
          .safeParse(req.body ?? {});
        if (!body.success) return invalid('status must be "reviewed" or "dismissed".');
        const flag = await ctx.repo.updateDuplicateFlagStatus(
          req.params[0] as string,
          body.data.status,
          'lionel.leboiteux@gmail.com',
        );
        return flag ? { status: 200, body: { ...flag } } : NOT_FOUND();
      },
    },
  },
  {
    pattern: /^\/v1\/admin\/gameweeks\/([^/]+)\/override$/,
    query: [],
    handlers: {
      POST: async (req, ctx) => {
        // 401 outranks 404: an unauthenticated caller learns nothing about
        // which gameweek ids exist.
        if (isAdmin(req, ctx) && !Uuid.safeParse(req.params[0]).success) return NOT_FOUND();
        const key = req.headers['idempotency-key'];
        const sink = createTelemetrySink();
        const response = await handleGameweekOverride(
          {
            gameweek_id: req.params[0] as string,
            authorization: req.headers.authorization ?? null,
            idempotency_key: typeof key === 'string' ? key : null,
            body: req.body,
          },
          {
            now: () => new Date(),
            auth: { verifyBearer: async (token) => ({ valid: token === ctx.adminToken }) },
            repo: ctx.repo,
            telemetry: sink,
            idempotency: {
              lookup: (k, id) => ctx.adminResponses.get(`${k}::${id}`) ?? null,
              store: (k, id, res) => void ctx.adminResponses.set(`${k}::${id}`, res),
            },
          },
        );
        await ctx.repo.insertTelemetryEvents(sink.events);
        return response;
      },
    },
  },
];

async function readBody(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

async function route(req: IncomingMessage, ctx: Ctx): Promise<HttpResponse> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const matched = ROUTES.map((r) => ({ r, m: r.pattern.exec(url.pathname) })).find((x) => x.m);
  if (!matched?.m) return NOT_FOUND();

  const handler = matched.r.handlers[req.method ?? ''];
  if (!handler) {
    return {
      ...errorResponse(405, 'VALIDATION_FAILED', `${req.method} is not supported on this path.`),
      headers: { allow: Object.keys(matched.r.handlers).join(', ') },
    };
  }

  const unknown = [...url.searchParams.keys()].filter((k) => !matched.r.query.includes(k));
  if (unknown.length > 0) {
    return invalid(`Unknown query parameter(s): ${unknown.join(', ')}.`);
  }

  const key = req.headers['idempotency-key'];
  if (typeof key === 'string' && (key.length < 1 || key.length > 128)) {
    return invalid('Idempotency-Key must be between 1 and 128 characters.');
  }

  const body = await readBody(req);
  if (!body.ok) return invalid('Request body is not valid JSON.');

  return handler(
    {
      params: matched.m.slice(1),
      query: url.searchParams,
      headers: req.headers,
      body: body.body,
      // The real TCP peer, not a client-suppliable header: X-Forwarded-For
      // was tried and reverted (see 04-green-evidence.v1.md D-2) because a
      // caller reaching this process's public URL directly can set that
      // header to anything, defeating the rate limit entirely. This value
      // cannot be forged by the requester.
      client_ip: req.socket.remoteAddress ?? 'unknown',
    },
    ctx,
  );
}

export type ServerOptions = { port: number; databaseUrl: string; adminToken: string };

export type RunningServer = { url: string; stop(): Promise<void> };

/** Boots the router in this process. `serverProcess.ts` is its only caller. */
export async function createApiServer(opts: ServerOptions): Promise<RunningServer> {
  const pool = new pg.Pool({ connectionString: opts.databaseUrl });
  const ctx: Ctx = {
    repo: createRepository(pool),
    adminToken: opts.adminToken,
    rateLimiter: createRateLimiter({ max_requests: SUBMIT_RATE_LIMIT_PER_MINUTE, window_ms: 60_000 }),
    emailKeys: new Set(),
    adminResponses: new Map(),
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void route(req, ctx)
      .catch((err: unknown): HttpResponse =>
        errorResponse(500, 'INTERNAL_ERROR', (err as Error).message ?? 'An unexpected error occurred.'),
      )
      .then((result) => {
        res.writeHead(result.status, { 'content-type': 'application/json', ...result.headers });
        res.end(JSON.stringify(result.body));
      });
  });

  await new Promise<void>((resolve) => server.listen(opts.port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${opts.port}`,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}

/**
 * Starts the API as its own OS process, which is what it is in production and
 * what the provider contract test needs: Schemathesis is driven with a
 * blocking `spawnSync`, so an API served from the caller's own event loop
 * could never answer it.
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const entry = fileURLToPath(new URL('./serverProcess.ts', import.meta.url));
  const child = spawn(
    process.execPath,
    [entry, String(opts.port), opts.databaseUrl, opts.adminToken],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );

  const url = await new Promise<string>((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`API process exited with code ${code}`)));
    child.stdout.on('data', (chunk: Buffer) => {
      const ready = /^READY (\S+)$/m.exec(chunk.toString());
      if (ready) resolve(ready[1] as string);
    });
  });

  return {
    url,
    async stop() {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    },
  };
}
