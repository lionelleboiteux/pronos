/**
 * POST /v1/page-view — a first-party, server-side view counter shared by
 * every fantasy-coach.fr sibling site (pronos, DNP, compos, groupes), same
 * accuracy reasoning as arsene-cms's own article-view counter: a consent-
 * gated client-side analytics tag only counts visitors who accept, and
 * DuckDuckGo/Firefox/Brave/ad-blockers drop the request to a known tracker
 * domain before consent even matters. This lands on pronos's own
 * already-trusted backend instead — the same one fc-shared/feedback.js
 * already posts to from every sibling site — so there's no third-party
 * domain for a blocklist to catch.
 *
 * No auth, same trust tier as /v1/feedback and /v1/predictions. Unlike
 * feedback's own 5/minute rate limit (there to throttle spammy free-text
 * submissions), a page-view beacon fires once per real page load — a
 * limit anywhere near that tight would undercount real traffic on exactly
 * the metric this endpoint exists to get right, so this has none.
 */

import { z } from 'zod';
import { errorResponse, type ApiResponse } from './errors.ts';

export type RecordPageViewRequest = {
  body: unknown;
};

export type RecordPageViewDeps = {
  repo: {
    insertPageView(input: { project: string; view?: string }): Promise<void>;
  };
};

/** Blank `view` arrives as '' from a client that always sends the field —
 *  treat that the same as omitted, same pattern as submitFeedback.ts's own
 *  pseudo/email handling. */
const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

// `view` is only ever meaningfully sent by pronos itself, the one sibling
// with more than one distinct page/view (picker, prediction form,
// standings, thank-you) — DNP/compos/groupes are each genuinely
// single-page, so they only ever send `project`.
const PageViewBody = z.object({
  project: z.string().trim().min(1).max(60),
  view: z.preprocess(emptyToUndefined, z.string().trim().max(60).optional()),
});

export async function handleRecordPageView(req: RecordPageViewRequest, deps: RecordPageViewDeps): Promise<ApiResponse> {
  const parsed = PageViewBody.safeParse(req.body);
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_FAILED', 'Request failed validation.', {
      fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  await deps.repo.insertPageView({ project: parsed.data.project, view: parsed.data.view });

  return { status: 200, body: {} };
}
