/**
 * Cloudflare Worker in front of the `api` Supabase Edge Function.
 *
 * Supabase bills every Edge Function invocation (free plan: 500k/month), and
 * its gateway does not cache function responses, so a `Cache-Control` header
 * alone only helps a browser's own repeat visits. This Worker answers the
 * high-volume public GETs from Cloudflare's cache and the CORS preflights
 * directly, so neither reaches Supabase. Everything else is proxied as-is.
 */

const ORIGIN = 'https://dmytkubjxwwwkroutvdu.supabase.co/functions/v1/api';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, idempotency-key',
  'access-control-max-age': '86400',
};

/** Seconds a cached copy is served before the origin is asked again. */
export function ttlFor(pathname: string, search: URLSearchParams): number | null {
  // A league's current gameweek with a pseudo is player-specific.
  if (/^\/v1\/leagues\/[^/]+\/current$/.test(pathname)) return search.has('pseudo') ? null : 60;
  // Last-5 results only change when a match ends.
  if (pathname === '/v1/teams/form') return 3600;
  if (pathname === '/v1/teams' || pathname === '/v1/leagues') return 300;
  if (/^\/v1\/leagues\/[^/]+\/seasons\/[^/]+\/standings\/overall$/.test(pathname)) return 60;
  return null;
}

export type CacheLike = {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
};

export type Deps = {
  cache: CacheLike;
  fetchOrigin: (req: Request) => Promise<Response>;
  waitUntil: (p: Promise<unknown>) => void;
};

function withCors(res: Response, extra: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...CORS_HEADERS, ...extra })) out.headers.set(k, v);
  return out;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  const url = new URL(req.url);
  const originReq = (): Request => new Request(ORIGIN + url.pathname + url.search, req);

  const ttl = req.method === 'GET' ? ttlFor(url.pathname, url.searchParams) : null;
  if (ttl === null) return deps.fetchOrigin(originReq());

  // Sorted params so `?a=1&b=2` and `?b=2&a=1` share an entry.
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const key = new Request(url.origin + url.pathname + '?' + new URLSearchParams(params).toString());

  const hit = await deps.cache.match(key);
  if (hit) return withCors(hit, { 'x-edge-cache': 'HIT' });

  const res = await deps.fetchOrigin(new Request(ORIGIN + url.pathname + '?' + new URLSearchParams(params), { method: 'GET' }));
  // Never cache errors (404 for an unknown team, 503 when the DB is busy).
  if (res.status !== 200) return res;

  // Supabase's gateway adds a Cloudflare `__cf_bm` Set-Cookie, and the Cache
  // API refuses to store any response carrying one. These routes are public
  // and cookie-free, so drop it from both the stored and returned copy.
  const cacheable = new Response(res.clone().body, res);
  cacheable.headers.delete('set-cookie');
  cacheable.headers.set('cache-control', `public, max-age=${ttl}, s-maxage=${ttl}`);
  deps.waitUntil(deps.cache.put(key, cacheable));
  const out = withCors(res, { 'cache-control': `public, max-age=${ttl}`, 'x-edge-cache': 'MISS' });
  out.headers.delete('set-cookie');
  return out;
}

export default {
  async fetch(req: Request, _env: unknown, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    return handle(req, {
      // deno-lint-ignore no-explicit-any
      cache: (globalThis as any).caches.default as CacheLike,
      fetchOrigin: (r) => fetch(r),
      waitUntil: (p) => ctx.waitUntil(p),
    });
  },
};
