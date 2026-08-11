/**
 * The Edge Function router: routing, request-boundary validation, and
 * turning handler results into an HTTP-shaped response. Every decision that
 * matters — the kickoff lock, the admin idempotency replay, telemetry —
 * lives in the handlers under src/api and the pure functions under
 * src/domain.
 *
 * This module has no Node or Deno types anywhere in it, deliberately: it is
 * imported unchanged by both the Node HTTP entrypoint (server.ts, used by
 * tests/e2e and Schemathesis) and the Deno/Supabase Edge Function entrypoint
 * (supabase/functions/api/index.ts), so routing/validation logic exists
 * exactly once regardless of which runtime is serving it.
 */

import { z } from 'zod';
import type { Repository } from '../db/repository.ts';
import { createTelemetrySink } from '../telemetry/events.ts';
import { errorResponse, type ApiResponse } from './errors.ts';
import { handleGetCurrentGameweek } from './getCurrentGameweek.ts';
import { handleGameweekOverride } from './adminOverride.ts';
import { handleSubmitPrediction, type SubmitRequest } from './submitPrediction.ts';
import { handleSendGameweekReceipt } from './sendGameweekReceipt.ts';
import { handleSyncFixtures } from './syncFixtures.ts';
import { handleSubmitFeedback } from './submitFeedback.ts';
import { SUBMIT_RATE_LIMIT_PER_MINUTE, createRateLimiter, type RateLimiter } from './rateLimit.ts';

/** An ApiResponse plus any header the HTTP layer itself owes (e.g. Allow). */
export type HttpResponse = ApiResponse & { headers?: Record<string, string> };

export type Ctx = {
  repo: Repository;
  adminToken: string;
  /**
   * Separate credential for the scheduled fixture-sync pipeline
   * (scripts/ingestion + GitHub Actions), deliberately distinct from
   * adminToken — least privilege for a CI-held secret. Defaults to
   * adminToken so existing tests/entrypoints that don't set it explicitly
   * keep working unchanged.
   */
  ingestToken?: string;
  rateLimiter: RateLimiter;
  /** Idempotency-Key replay stores, in-memory for a single function instance. */
  emailKeys: Set<string>;
  adminResponses: Map<string, ApiResponse>;
  /**
   * Only used by the consolidated gameweek-receipt route below —
   * submitPrediction's own per-match mailer dependency is separate and
   * intentionally still a no-op (see the /v1/predictions handler).
   */
  mailer: { sendReceipt(to: string, subject: string, text: string, html: string): Promise<boolean> };
  /** Where POST /v1/feedback notifications go. Defaults to the game's own inbox. */
  feedbackNotifyTo?: string;
};

const FEEDBACK_RATE_LIMIT_PER_MINUTE = 5;
const feedbackRateLimiter = createRateLimiter({
  max_requests: FEEDBACK_RATE_LIMIT_PER_MINUTE,
  window_ms: 60_000,
});

/**
 * Transport-agnostic request shape. `headers` is single-valued: every header
 * this router reads (`authorization`, `idempotency-key`) is single-valued on
 * the wire in both Node and Deno, so each entrypoint normalizes its own
 * transport's headers (which may support multi-valued headers in general)
 * down to this shape before calling `handleRequest`.
 */
export type Request = {
  params: string[];
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
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
    pattern: /^\/v1\/teams$/,
    query: ['league_id'],
    handlers: {
      GET: async (req, ctx) => {
        const league_id = req.query.get('league_id');
        if (league_id !== null && !Uuid.safeParse(league_id).success) {
          return invalid('league_id must be a UUID.');
        }
        return { status: 200, body: { data: await ctx.repo.listTeams(league_id) } };
      },
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
            // Deliberately still a no-op, not ctx.mailer: this fires once
            // per match (10 calls for a 10-match gameweek), and a player
            // wants one consolidated email, not ten. The frontend no longer
            // sends `email` on these per-match calls at all — real sending
            // happens once, from the /receipt route below, after all of a
            // gameweek's matches are submitted. See sendGameweekReceipt.ts.
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
    pattern: /^\/v1\/standings\/cross-league$/,
    query: ['week', 'page', 'per_page'],
    handlers: {
      GET: async (req, ctx) => {
        const week = req.query.get('week');
        if (week !== null && !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
          return invalid('week must be a date in YYYY-MM-DD format.');
        }
        const q = paginationOf(req.query);
        if (!q) return invalid('page and per_page must be within the documented ranges.');
        const found = await ctx.repo.getCrossLeagueWeeklyStandings({ week, ...q });
        return {
          status: 200,
          body: {
            week_start: found.week_start,
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
  {
    pattern: /^\/v1\/ingest\/fixtures$/,
    query: [],
    handlers: {
      POST: async (req, ctx) => {
        return handleSyncFixtures(
          { authorization: req.headers.authorization ?? null, body: req.body },
          {
            auth: {
              verifyBearer: async (token) => ({ valid: token === (ctx.ingestToken ?? ctx.adminToken) }),
            },
            repo: ctx.repo,
          },
        );
      },
    },
  },
  {
    pattern: /^\/v1\/feedback$/,
    query: [],
    handlers: {
      POST: async (req, ctx) => {
        return handleSubmitFeedback(
          { body: req.body, client_ip: req.client_ip },
          {
            repo: ctx.repo,
            mailer: ctx.mailer,
            rateLimiter: feedbackRateLimiter,
            now: () => new Date(),
            notifyTo: ctx.feedbackNotifyTo ?? 'fantasycoachfr@gmail.com',
          },
        );
      },
    },
  },
  {
    pattern: /^\/v1\/leagues\/([^/]+)\/gameweeks\/([^/]+)\/receipt$/,
    query: [],
    handlers: {
      POST: async (req, ctx) => {
        const ids = z.tuple([Uuid, Uuid]).safeParse(req.params);
        if (!ids.success) return NOT_FOUND();
        const body = (req.body ?? {}) as { pseudo?: unknown; email?: unknown };
        return handleSendGameweekReceipt(
          {
            league_id: ids.data[0],
            gameweek_id: ids.data[1],
            pseudo: body.pseudo as string,
            email: body.email as string,
          },
          { repo: ctx.repo, mailer: ctx.mailer },
        );
      },
    },
  },
];

/**
 * Matches, validates, and dispatches an already-decoded request. This is the
 * entire router aside from wire-format decoding, which is each entrypoint's
 * own job (see the module doc comment above).
 */
export async function handleRequest(
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  req: Request,
  ctx: Ctx,
): Promise<HttpResponse> {
  const matched = ROUTES.map((r) => ({ r, m: r.pattern.exec(pathname) })).find((x) => x.m);
  if (!matched?.m) return NOT_FOUND();

  const handler = matched.r.handlers[method];
  if (!handler) {
    return {
      ...errorResponse(405, 'VALIDATION_FAILED', `${method} is not supported on this path.`),
      headers: { allow: Object.keys(matched.r.handlers).join(', ') },
    };
  }

  const unknown = [...searchParams.keys()].filter((k) => !matched.r.query.includes(k));
  if (unknown.length > 0) {
    return invalid(`Unknown query parameter(s): ${unknown.join(', ')}.`);
  }

  const key = req.headers['idempotency-key'];
  if (typeof key === 'string' && (key.length < 1 || key.length > 128)) {
    return invalid('Idempotency-Key must be between 1 and 128 characters.');
  }

  return handler({ ...req, params: matched.m.slice(1), query: searchParams }, ctx);
}
