/**
 * Kickoff lock — pure function over (now, game.starts_at), the single
 * authority for AC-01/AC-02. The client's own belief about lock state is
 * deliberately never read (NFR-LOCK-01).
 */

export type GameRef = {
  id: string;
  league_id: string;
  gameweek_id: string;
  starts_at: Date;
};

export type SubmissionAttempt = {
  now: Date;
  game: GameRef;
  pseudo: string;
  predicted_home_score: number;
  predicted_away_score: number;
  client_claims_unlocked?: boolean;
};

export type SubmissionOutcome =
  | { accepted: true }
  | { accepted: false; status: 409; error_code: 'MATCH_LOCKED' };

/** True when starts_at <= now. The kickoff instant itself counts as locked. */
export function isLocked(now: Date, startsAt: Date): boolean {
  return startsAt.getTime() <= now.getTime();
}

export function evaluateSubmission(attempt: SubmissionAttempt): SubmissionOutcome {
  if (isLocked(attempt.now, attempt.game.starts_at)) {
    return { accepted: false, status: 409, error_code: 'MATCH_LOCKED' };
  }
  return { accepted: true };
}
