/**
 * The Cloudflare Worker that keeps public reads and CORS preflights off
 * Supabase's metered Edge Function invocations.
 */

import { describe, expect, it } from 'vitest';
import { handle, ttlFor, type CacheLike } from '../../cloudflare/api-cache/index.ts';

function harness(status = 200) {
  const store = new Map<string, Response>();
  const cache: CacheLike = {
    match: async (r) => store.get(r.url)?.clone(),
    put: async (r, res) => void store.set(r.url, res),
  };
  const origin: string[] = [];
  const pending: Promise<unknown>[] = [];
  const deps = {
    cache,
    fetchOrigin: async (r: Request) => {
      origin.push(r.url);
      return Response.json({ ok: true }, { status });
    },
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
  };
  return { deps, origin, settle: () => Promise.all(pending) };
}

const get = (path: string) => new Request('https://api.fantasy-coach.fr' + path);

describe('api cache worker', () => {
  it('answers CORS preflights without calling the origin', async () => {
    const h = harness();
    const res = await handle(new Request(get('/v1/page-view'), { method: 'OPTIONS' }), h.deps);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(h.origin).toHaveLength(0);
  });

  it('serves a repeated teams/form read from cache, whatever the param order', async () => {
    const h = harness();
    const first = await handle(get('/v1/teams/form?league=L1&name=OM'), h.deps);
    await h.settle();
    const second = await handle(get('/v1/teams/form?name=OM&league=L1'), h.deps);
    expect(first.headers.get('x-edge-cache')).toBe('MISS');
    expect(second.headers.get('x-edge-cache')).toBe('HIT');
    expect(h.origin).toHaveLength(1);
    expect(h.origin[0]).toBe(
      'https://dmytkubjxwwwkroutvdu.supabase.co/functions/v1/api/v1/teams/form?league=L1&name=OM',
    );
  });

  it('strips Supabase gateway cookies, which would stop the Cache API storing the entry', async () => {
    const h = harness();
    h.deps.fetchOrigin = async () =>
      new Response('{}', { headers: { 'set-cookie': '__cf_bm=x; Path=/', 'content-type': 'application/json' } });
    let stored: Response | undefined;
    h.deps.cache.put = async (_r, res) => void (stored = res);
    const res = await handle(get('/v1/teams/form?league=L1&name=OM'), h.deps);
    await h.settle();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(stored?.headers.get('set-cookie')).toBeNull();
  });

  it('does not cache non-200 responses', async () => {
    const h = harness(404);
    await handle(get('/v1/teams/form?league=L1&name=Nope'), h.deps);
    await h.settle();
    await handle(get('/v1/teams/form?league=L1&name=Nope'), h.deps);
    expect(h.origin).toHaveLength(2);
  });

  it('never caches player-specific or write requests', async () => {
    const h = harness();
    await handle(get('/v1/leagues/abc/current?pseudo=bob'), h.deps);
    await handle(get('/v1/leagues/abc/current?pseudo=bob'), h.deps);
    await handle(new Request(get('/v1/page-view'), { method: 'POST', body: '{}' }), h.deps);
    expect(h.origin).toHaveLength(3);
  });

  it('assigns TTLs only to public read routes', () => {
    expect(ttlFor('/v1/teams/form', new URLSearchParams())).toBe(3600);
    expect(ttlFor('/v1/leagues/abc/current', new URLSearchParams())).toBe(60);
    expect(ttlFor('/v1/leagues/abc/current', new URLSearchParams('pseudo=x'))).toBeNull();
    expect(ttlFor('/v1/predictions', new URLSearchParams())).toBeNull();
  });
});
