/**
 * Node HTTP entrypoint: wire-format decoding only. Routing, request-boundary
 * validation, and every decision that matters (the kickoff lock, the admin
 * idempotency replay, telemetry) lives in router.ts and the handlers under
 * src/api, shared verbatim with the Deno/Supabase Edge Function entrypoint
 * (supabase/functions/api/index.ts). This file exists so the same routing
 * code can be fuzzed against contracts/openapi.yaml over plain HTTP in tests.
 */

import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createRepository } from '../db/repository.ts';
import { errorResponse } from './errors.ts';
import { createRateLimiter, SUBMIT_RATE_LIMIT_PER_MINUTE } from './rateLimit.ts';
import { handleRequest, type Ctx, type HttpResponse } from './router.ts';

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

/**
 * Node normally comma-joins repeated headers, keeping only a handful (like
 * `set-cookie`) as arrays; neither header this router reads is one of those,
 * so the first value (if ever an array) is equivalent in practice — this
 * just gives router.ts's transport-agnostic `Request` a single-valued type.
 */
function toSingleValuedHeaders(headers: IncomingMessage['headers']): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

async function route(req: IncomingMessage, ctx: Ctx): Promise<HttpResponse> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  const body = await readBody(req);
  if (!body.ok) return errorResponse(400, 'VALIDATION_FAILED', 'Request body is not valid JSON.');

  return handleRequest(
    req.method ?? '',
    url.pathname,
    url.searchParams,
    {
      params: [],
      query: url.searchParams,
      headers: toSingleValuedHeaders(req.headers),
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
