import { describe, it, expect } from 'vitest';
import { handleSubmitFeedback, type SubmitFeedbackDeps, type SubmitFeedbackRequest } from '../../src/api/submitFeedback.ts';

/**
 * POST /v1/feedback — now shared by pronos, DNP, and compos via fc-shared's
 * <fc-feedback>, tagged with a `project` field so submissions from all three
 * sites stay distinguishable in one table.
 */

function buildDeps(overrides: Partial<SubmitFeedbackDeps> = {}): {
  deps: SubmitFeedbackDeps;
  inserts: Array<{ message: string; client_ip: string; project: string }>;
} {
  const inserts: Array<{ message: string; client_ip: string; project: string }> = [];
  const deps: SubmitFeedbackDeps = {
    repo: {
      insertFeedback: async (message, client_ip, project) => {
        inserts.push({ message, client_ip, project });
        return { id: 'a1a1a1a1-0000-4a2b-9c3d-eeeeeeeeeeee' };
      },
    },
    mailer: { sendReceipt: async () => true },
    rateLimiter: { check: () => ({ allowed: true, limit: 1_000_000 }) },
    now: () => new Date('2026-08-31T12:00:00Z'),
    notifyTo: 'fantasycoachfr@gmail.com',
    ...overrides,
  };
  return { deps, inserts };
}

const req = (overrides: Partial<SubmitFeedbackRequest> = {}): SubmitFeedbackRequest => ({
  body: { message: 'Bravo pour le site !' },
  client_ip: '203.0.113.7',
  ...overrides,
});

describe('feedback project tagging', () => {
  it('persists the project sent by the client (e.g. DNP or compos)', async () => {
    const { deps, inserts } = buildDeps();

    const res = await handleSubmitFeedback(req({ body: { message: 'Merci !', project: 'DNP' } }), deps);

    expect(res.status).toBe(200);
    expect(inserts).toEqual([{ message: 'Merci !', client_ip: '203.0.113.7', project: 'DNP' }]);
  });

  it('defaults to project "pronos" when no project is sent (older/direct clients)', async () => {
    const { deps, inserts } = buildDeps();

    await handleSubmitFeedback(req(), deps);

    expect(inserts).toEqual([{ message: 'Bravo pour le site !', client_ip: '203.0.113.7', project: 'pronos' }]);
  });
});
