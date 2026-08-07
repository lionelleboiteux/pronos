/**
 * POST /v1/leagues/{leagueId}/gameweeks/{gameweekId}/receipt — sends one
 * consolidated email of everything a pseudo picked in a gameweek. Separate
 * from submitPrediction's per-match flow on purpose: the frontend submits
 * one prediction per match (10 calls for a 10-match gameweek), but a player
 * wants one email, not ten — see 12-email-receipt.v1.md.
 */

import { z } from 'zod';
import { errorResponse, type ApiResponse } from './errors.ts';
import type { GameweekPicks } from '../db/repository.ts';

export type SendReceiptRequest = {
  league_id: string;
  gameweek_id: string;
  pseudo: string;
  email: string;
};

export type SendReceiptDeps = {
  repo: {
    getPlayerGameweekPicks(league_id: string, gameweek_id: string, pseudo: string): Promise<GameweekPicks | null>;
  };
  mailer: { sendReceipt(to: string, subject: string, text: string): Promise<boolean> };
};

/** Same permissive syntactic check as submitPrediction.ts — see its comment. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const Body = z.object({
  league_id: z.uuid(),
  gameweek_id: z.uuid(),
  pseudo: z.string().min(1).max(60),
  email: z.string().regex(EMAIL),
});

export function buildReceiptEmail(pseudo: string, data: GameweekPicks): { subject: string; text: string } {
  const subject = `Confirmation de pronos ${data.league_name} J${data.gameweek_number}`;
  const lines = data.picks.map(
    (p) => `${p.home_team} ${p.predicted_home_score} - ${p.predicted_away_score} ${p.away_team}`,
  );
  const text = `Salut ${pseudo}\n\nVoici la confirmation que nous avons bien reçu tes pronos:\n\n${lines.join('\n')}\n\nBonne chance`;
  return { subject, text };
}

export async function handleSendGameweekReceipt(
  req: SendReceiptRequest,
  deps: SendReceiptDeps,
): Promise<ApiResponse> {
  const parsed = Body.safeParse(req);
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_FAILED', 'Request failed validation.', {
      fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  const data = await deps.repo.getPlayerGameweekPicks(parsed.data.league_id, parsed.data.gameweek_id, parsed.data.pseudo);
  if (!data || data.picks.length === 0) {
    return errorResponse(404, 'NOT_FOUND', 'No predictions were found for this pseudo in this gameweek.');
  }

  const { subject, text } = buildReceiptEmail(parsed.data.pseudo, data);
  const email_sent = await deps.mailer.sendReceipt(parsed.data.email, subject, text);

  return { status: 200, body: { email_sent } };
}
