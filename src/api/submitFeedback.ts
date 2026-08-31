/**
 * POST /v1/feedback — the free-text box under Hall of Fame. No auth (same
 * trust tier as /v1/predictions, the app's other anonymous write path), so
 * it gets the same two defenses: NFR-RATE-01-style IP rate limiting against
 * spam/abuse, and a hard length cap. The message is always written to the
 * feedback table via a parameterized query (never string-built — no SQL
 * injection surface) before the best-effort email notification, so a
 * submission is never lost just because Gmail is unreachable.
 */

import { z } from 'zod';
import { errorResponse, type ApiResponse } from './errors.ts';

export type SubmitFeedbackRequest = {
  body: unknown;
  client_ip: string;
};

export type SubmitFeedbackDeps = {
  repo: { insertFeedback(message: string, client_ip: string, project: string): Promise<{ id: string }> };
  mailer: { sendReceipt(to: string, subject: string, text: string, html: string): Promise<boolean> };
  rateLimiter: { check(key: string, now: Date): { allowed: boolean; limit: number } };
  now(): Date;
  notifyTo: string;
};

// project defaults to 'pronos': fc-shared's <fc-feedback> always sends it
// explicitly, but this keeps pre-existing/older clients working.
const FeedbackBody = z.object({
  message: z.string().trim().min(1).max(2000),
  project: z.string().trim().min(1).max(60).default('pronos'),
});

/** Minimal escaping — this message only ever renders inside an HTML email, never in the app itself. */
const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function handleSubmitFeedback(
  req: SubmitFeedbackRequest,
  deps: SubmitFeedbackDeps,
): Promise<ApiResponse> {
  const { allowed, limit } = deps.rateLimiter.check(req.client_ip, deps.now());
  if (!allowed) {
    return errorResponse(429, 'CONFLICT', 'Too many feedback submissions from this address.', {
      limit_per_minute: limit,
    });
  }

  const parsed = FeedbackBody.safeParse(req.body);
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_FAILED', 'Request failed validation.', {
      fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  const { id } = await deps.repo.insertFeedback(parsed.data.message, req.client_ip, parsed.data.project);

  // Best-effort: the submission is already durably stored above, so a Gmail
  // outage must not turn into a 500 for the player.
  await deps.mailer.sendReceipt(
    deps.notifyTo,
    'Nouveau feedback — ' + parsed.data.project,
    parsed.data.message,
    '<p>' + escapeHtml(parsed.data.message).replace(/\n/g, '<br>') + '</p>',
  ).catch(() => false);

  return { status: 200, body: { id } };
}
