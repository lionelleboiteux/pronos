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
  mailer: { sendReceipt(to: string, subject: string, text: string, html: string): Promise<boolean> };
};

/** Same permissive syntactic check as submitPrediction.ts — see its comment. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const Body = z.object({
  league_id: z.uuid(),
  gameweek_id: z.uuid(),
  pseudo: z.string().min(1).max(60),
  email: z.string().regex(EMAIL),
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildReceiptEmail(pseudo: string, data: GameweekPicks): { subject: string; text: string; html: string } {
  const subject = `Confirmation de pronos ${data.league_name} J${data.gameweek_number}`;

  // Plain-text fallback: padded for clients that do render monospace, but
  // Gmail's own plain-text view uses a proportional font, so this alone
  // never lines up there — the html part below is what actually renders
  // aligned in the client this was built for. Kept anyway: cheap, and a
  // real improvement for any client that does honor whitespace.
  const maxHomeLen = Math.max(...data.picks.map((p) => p.home_team.length));
  const textLines = data.picks.map(
    (p) =>
      `${p.home_team.padStart(maxHomeLen)} ${String(p.predicted_home_score).padStart(2)} - ` +
      `${String(p.predicted_away_score).padEnd(2)} ${p.away_team}`,
  );
  const text = `Salut ${pseudo}\n\nVoici la confirmation que nous avons bien reçu tes pronos:\n\n${textLines.join('\n')}\n\nBonne chance`;

  const rows = data.picks
    .map(
      (p) => `
      <tr>
        <td style="text-align:right; padding:4px 8px; white-space:nowrap;">${escapeHtml(p.home_team)}</td>
        <td style="text-align:right; padding:4px 2px; font-weight:bold;">${p.predicted_home_score}</td>
        <td style="text-align:center; padding:4px 2px; color:#6b6560;">-</td>
        <td style="text-align:left; padding:4px 2px; font-weight:bold;">${p.predicted_away_score}</td>
        <td style="text-align:left; padding:4px 8px; white-space:nowrap;">${escapeHtml(p.away_team)}</td>
      </tr>`,
    )
    .join('');
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; color:#1c1917;">
      <p>Salut ${escapeHtml(pseudo)}</p>
      <p>Voici la confirmation que nous avons bien reçu tes pronos&nbsp;:</p>
      <table style="border-collapse:collapse; margin:0.5em 0;" cellpadding="0" cellspacing="0">
        ${rows}
      </table>
      <p>Bonne chance</p>
    </div>`;

  return { subject, text, html };
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

  const { subject, text, html } = buildReceiptEmail(parsed.data.pseudo, data);
  const email_sent = await deps.mailer.sendReceipt(parsed.data.email, subject, text, html);

  return { status: 200, body: { email_sent } };
}
