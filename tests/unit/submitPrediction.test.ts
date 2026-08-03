import { describe, it, expect } from 'vitest';
import { loadRateLimit, loadSubmitPrediction } from '../support/seams.js';
import type { SubmitRequest } from '../support/seams.js';
import { buildSubmitDeps, fakeRateLimiter } from '../support/fakes.js';
import { GAME_ASM_LOSC, LEAGUE_LIGUE_1, gameRecord, t } from '../support/fixtures.js';

/**
 * POST /v1/predictions handler behaviour that is not the pure lock check:
 * the email receipt side effect (AC-12), the email-idempotency window, and
 * the DoS rate limit from 02-architecture.v1.md §7.
 */

const NOW = t('2026-08-09T09:12:03Z');
const OPEN_GAME = gameRecord({ starts_at: t('2026-08-10T19:00:00Z') });

const req = (overrides: Partial<SubmitRequest> = {}): SubmitRequest => ({
  league_id: LEAGUE_LIGUE_1,
  game_id: GAME_ASM_LOSC,
  pseudo: 'Lio_92',
  predicted_home_score: 2,
  predicted_away_score: 1,
  client_ip: '203.0.113.7',
  ...overrides,
});

describe('prediction submission side effects', () => {
  it('AC-12: a valid optional email produces a receipt to that address', async () => {
    const api = await loadSubmitPrediction();
    const { deps, sentEmails } = buildSubmitDeps(OPEN_GAME, { now: NOW });

    await api.handleSubmitPrediction(req({ email: 'lio92@example.com' }), deps);

    expect(sentEmails.map((e) => e.to)).toEqual(['lio92@example.com']);
  });

  it('AC-12: a blank email field still succeeds with 200 and sends nothing', async () => {
    const api = await loadSubmitPrediction();
    const { deps, sentEmails } = buildSubmitDeps(OPEN_GAME, { now: NOW });

    const res = await api.handleSubmitPrediction(req({ email: null }), deps);

    expect({ status: res.status, email_receipt_queued: res.body.email_receipt_queued, sent: sentEmails.length }).toEqual({
      status: 200,
      email_receipt_queued: false,
      sent: 0,
    });
  });

  it('NFR-IDEM-03: replaying the same Idempotency-Key inside the 5-minute window does not send a second receipt', async () => {
    const api = await loadSubmitPrediction();
    const { deps, sentEmails } = buildSubmitDeps(OPEN_GAME, { now: NOW });
    const body = req({ email: 'lio92@example.com', idempotency_key: '6c1a9e2b-4b1a-4e2b-9c3a-abcdefabcdef' });

    await api.handleSubmitPrediction(body, deps);
    await api.handleSubmitPrediction(body, deps);

    expect(sentEmails).toHaveLength(1);
  });
});

describe('submit endpoint rate limiting', () => {
  /**
   * NFR-RATE-01. 02-architecture.v1.md §7 leaves the threshold unspecified
   * ("e.g. N/minute/IP"). ASSUMED_LIMIT below is a placeholder chosen by this
   * test suite, NOT an agreed product decision — flagged in traceability.md
   * as needing product-owner confirmation.
   */
  const ASSUMED_LIMIT = 10;

  const RATE_CASES = [
    { id: 'NFR-RATE-01a', klass: `request ${ASSUMED_LIMIT} of ${ASSUMED_LIMIT} from one IP`, priorRequests: ASSUMED_LIMIT - 1, ip: '203.0.113.7', expectedStatus: 200 },
    { id: 'NFR-RATE-01b', klass: `request ${ASSUMED_LIMIT + 1} from the same IP`, priorRequests: ASSUMED_LIMIT, ip: '203.0.113.7', expectedStatus: 429 },
    { id: 'NFR-RATE-01c', klass: 'a different IP is unaffected by the first IP’s usage', priorRequests: ASSUMED_LIMIT, ip: '198.51.100.4', expectedStatus: 200 },
  ];

  it.each(
    RATE_CASES.map((c) => [`${c.id}: ${c.klass} responds ${c.expectedStatus}`, c] as const),
  )('%s', async (_title, { priorRequests, ip, expectedStatus }) => {
    const api = await loadSubmitPrediction();
    const limiter = fakeRateLimiter(ASSUMED_LIMIT);
    const { deps } = buildSubmitDeps(OPEN_GAME, { now: NOW });
    deps.rateLimiter = limiter;

    for (let i = 0; i < priorRequests; i += 1) {
      await api.handleSubmitPrediction(req({ client_ip: '203.0.113.7' }), deps);
    }

    const res = await api.handleSubmitPrediction(req({ client_ip: ip }), deps);

    expect(res.status).toBe(expectedStatus);
  });

  it('NFR-RATE-01: the shipped limiter exposes the configured per-minute-per-IP threshold', async () => {
    const rl = await loadRateLimit();

    // The number itself is a product decision; this asserts only that a
    // concrete, positive threshold is configured rather than left implicit.
    expect(rl.SUBMIT_RATE_LIMIT_PER_MINUTE).toBeGreaterThan(0);
  });
});
