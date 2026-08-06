import { describe, it, expect } from 'vitest';
import { loadLock } from '../support/seams.js';
import type { GameRef } from '../support/seams.js';
import { GAME_OM_PSG, GAMEWEEK_15, LEAGUE_LIGUE_1, t } from '../support/fixtures.js';

/**
 * Lock / reject check — 02-architecture.v1.md §1, seam:
 * "pure function over (now, game.starts_at)", called by the submit endpoint
 * (authoritative) and by the frontend (cosmetic only).
 */

const KICKOFF = t('2026-08-09T18:45:00Z');

const ligue1Gw15Match: GameRef = {
  id: GAME_OM_PSG,
  league_id: LEAGUE_LIGUE_1,
  gameweek_id: GAMEWEEK_15,
  starts_at: KICKOFF,
};

describe('kickoff lock', () => {
  it('AC-01: a submission for a Ligue 1 gameweek 15 match that kicked off 10 minutes ago is rejected as MATCH_LOCKED', async () => {
    const lock = await loadLock();

    const outcome = lock.evaluateSubmission({
      now: t('2026-08-09T18:55:00Z'), // 10 minutes after kickoff
      game: ligue1Gw15Match,
      pseudo: 'Lio_92',
      predicted_home_score: 2,
      predicted_away_score: 1,
    });

    expect(outcome).toEqual({ accepted: false, status: 409, error_code: 'MATCH_LOCKED' });
  });

  it('NFR-LOCK-01: a client claiming the match is not locked is still rejected, because starts_at is the only authority', async () => {
    const lock = await loadLock();

    const outcome = lock.evaluateSubmission({
      now: t('2026-08-09T18:55:00Z'),
      game: ligue1Gw15Match,
      pseudo: 'Lio_92',
      predicted_home_score: 2,
      predicted_away_score: 1,
      client_claims_unlocked: true, // tampered/stale client state
    });

    expect(outcome).toEqual({ accepted: false, status: 409, error_code: 'MATCH_LOCKED' });
  });

  // Boundary partition around the kickoff instant. The contract says
  // `starts_at <= now()`, so the kickoff instant itself is locked.
  const BOUNDARY = [
    { id: 'NFR-LOCK-02a', klass: 'one millisecond before kickoff', now: new Date(KICKOFF.getTime() - 1), expected: false },
    { id: 'NFR-LOCK-02b', klass: 'exactly at kickoff', now: new Date(KICKOFF.getTime()), expected: true },
    { id: 'NFR-LOCK-02c', klass: 'one millisecond after kickoff', now: new Date(KICKOFF.getTime() + 1), expected: true },
  ];

  it.each(
    BOUNDARY.map((c) => [`${c.id}: ${c.klass} gives isLocked=${c.expected}`, c] as const),
  )('%s', async (_title, { now, expected }) => {
    const lock = await loadLock();
    expect(lock.isLocked(now, KICKOFF)).toBe(expected);
  });
});
