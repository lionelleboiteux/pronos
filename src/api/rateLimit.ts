/**
 * NFR-RATE-01 — the public submit endpoint is the one unauthenticated write
 * path, so it is rate-limited per IP (02-architecture.v1.md §7, Denial of
 * service). Threshold confirmed by Lio on 2026-08-03.
 */

export const SUBMIT_RATE_LIMIT_PER_MINUTE = 10;

export type RateLimiter = {
  check(key: string, now: Date): { allowed: boolean; limit: number };
};

/** Sliding window over the timestamps of the requests still inside it. */
export function createRateLimiter(opts: { max_requests: number; window_ms: number }): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    check(key, now) {
      const cutoff = now.getTime() - opts.window_ms;
      const recent = (hits.get(key) ?? []).filter((at) => at > cutoff);
      recent.push(now.getTime());
      hits.set(key, recent);
      return { allowed: recent.length <= opts.max_requests, limit: opts.max_requests };
    },
  };
}
