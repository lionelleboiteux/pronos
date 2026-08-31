import { describe, it, expect } from 'vitest';
import { handleSubmitFeedback, type SubmitFeedbackDeps, type SubmitFeedbackRequest } from '../../src/api/submitFeedback.ts';

/**
 * POST /v1/feedback — now shared by pronos, DNP, and compos via fc-shared's
 * <fc-feedback>, tagged with a `project` field so submissions from all three
 * sites stay distinguishable in one table, and carrying an optional
 * pseudo/email so Lio knows who to reply to.
 */

type Insert = { message: string; client_ip: string; project: string; pseudo?: string; email?: string };
type SentEmail = { to: string; subject: string; text: string; html: string };

function buildDeps(overrides: Partial<SubmitFeedbackDeps> = {}): {
  deps: SubmitFeedbackDeps;
  inserts: Insert[];
  sentEmails: SentEmail[];
} {
  const inserts: Insert[] = [];
  const sentEmails: SentEmail[] = [];
  const deps: SubmitFeedbackDeps = {
    repo: {
      insertFeedback: async (input) => {
        inserts.push(input);
        return { id: 'a1a1a1a1-0000-4a2b-9c3d-eeeeeeeeeeee' };
      },
    },
    mailer: {
      sendReceipt: async (to, subject, text, html) => {
        sentEmails.push({ to, subject, text, html });
        return true;
      },
    },
    rateLimiter: { check: () => ({ allowed: true, limit: 1_000_000 }) },
    now: () => new Date('2026-08-31T12:00:00Z'),
    notifyTo: 'fantasycoachfr@gmail.com',
    ...overrides,
  };
  return { deps, inserts, sentEmails };
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
    expect(inserts).toEqual([{ message: 'Merci !', client_ip: '203.0.113.7', project: 'DNP', pseudo: undefined, email: undefined }]);
  });

  it('defaults to project "pronos" when no project is sent (older/direct clients)', async () => {
    const { deps, inserts } = buildDeps();

    await handleSubmitFeedback(req(), deps);

    expect(inserts[0].project).toBe('pronos');
  });
});

describe('optional pseudo/email contact details', () => {
  it('persists pseudo and email when both are provided', async () => {
    const { deps, inserts } = buildDeps();

    await handleSubmitFeedback(
      req({ body: { message: 'Bug sur la page Ligue 1', project: 'pronos', pseudo: 'Lio92', email: 'lio92@example.com' } }),
      deps,
    );

    expect(inserts[0]).toMatchObject({ pseudo: 'Lio92', email: 'lio92@example.com' });
  });

  it('succeeds with neither pseudo nor email, since both are optional', async () => {
    const { deps, inserts } = buildDeps();

    const res = await handleSubmitFeedback(req({ body: { message: 'Juste un merci' } }), deps);

    expect(res.status).toBe(200);
    expect(inserts[0].pseudo).toBeUndefined();
    expect(inserts[0].email).toBeUndefined();
  });

  it('treats blank pseudo/email strings the same as omitted', async () => {
    const { deps, inserts } = buildDeps();

    await handleSubmitFeedback(req({ body: { message: 'Test', pseudo: '  ', email: '' } }), deps);

    expect(inserts[0].pseudo).toBeUndefined();
    expect(inserts[0].email).toBeUndefined();
  });

  it('rejects a malformed email with 400 rather than silently dropping it', async () => {
    const { deps } = buildDeps();

    const res = await handleSubmitFeedback(req({ body: { message: 'Test', email: 'not-an-email' } }), deps);

    expect(res.status).toBe(400);
  });

  it('includes pseudo and email in the notification email sent to Lio', async () => {
    const { deps, sentEmails } = buildDeps();

    await handleSubmitFeedback(
      req({ body: { message: 'Une suggestion', pseudo: 'Lio92', email: 'lio92@example.com' } }),
      deps,
    );

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].text).toContain('Pseudo : Lio92');
    expect(sentEmails[0].text).toContain('Email : lio92@example.com');
    expect(sentEmails[0].html).toContain('Lio92');
    expect(sentEmails[0].html).toContain('lio92@example.com');
  });

  it('omits the contact lines from the notification email when neither is provided', async () => {
    const { deps, sentEmails } = buildDeps();

    await handleSubmitFeedback(req({ body: { message: 'Juste un merci' } }), deps);

    expect(sentEmails[0].text).toBe('Juste un merci');
  });
});
