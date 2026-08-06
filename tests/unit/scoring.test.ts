import { describe, it, expect } from 'vitest';
import { loadScoring } from '../support/seams.js';
import type { MatchScoringInput } from '../support/seams.js';

/**
 * Scoring calculator — 02-architecture.v1.md §1, seam:
 * "pure function over (prediction, actual scores), no DB/network".
 *
 * Matrix confirmed by Lio: 5 exact score, 3 correct outcome + goal
 * difference, 2 correct outcome only, 0 otherwise.
 */

type MatrixCase = {
  id: string;
  klass: string;
  prediction: { home: number; away: number };
  result: { home: number; away: number };
  expected: number;
};

// One value per equivalence class, plus the two classes that are easy to
// conflate (exact draw vs correct-outcome draw; same-GD win vs different-GD win).
const SCORING_MATRIX: MatrixCase[] = [
  { id: 'SPEC-SCORING-01a', klass: 'exact score, home win', prediction: { home: 2, away: 1 }, result: { home: 2, away: 1 }, expected: 5 },
  { id: 'SPEC-SCORING-01b', klass: 'exact score, draw', prediction: { home: 1, away: 1 }, result: { home: 1, away: 1 }, expected: 5 },
  { id: 'SPEC-SCORING-01c', klass: 'correct outcome + goal difference, not exact', prediction: { home: 2, away: 1 }, result: { home: 3, away: 2 }, expected: 3 },
  { id: 'SPEC-SCORING-01d', klass: 'correct outcome only, wrong goal difference', prediction: { home: 2, away: 1 }, result: { home: 4, away: 0 }, expected: 2 },
  { id: 'SPEC-SCORING-01e', klass: 'wrong outcome (predicted home win, away won)', prediction: { home: 2, away: 1 }, result: { home: 0, away: 1 }, expected: 0 },
  { id: 'SPEC-SCORING-01f', klass: 'wrong outcome (predicted draw, home won)', prediction: { home: 1, away: 1 }, result: { home: 2, away: 1 }, expected: 0 },
];

describe('scoring calculator', () => {
  it.each(
    SCORING_MATRIX.map((c) => [`${c.id}: ${c.klass} scores ${c.expected}`, c] as const),
  )('%s', async (_title, { prediction, result, expected }) => {
    const scoring = await loadScoring();
    expect(scoring.scoreMatch(prediction, result)).toBe(expected);
  });

  it('AC-03: a match the player never predicted scores zero and is excluded from the scored-match count, not recorded as a wrong prediction', async () => {
    const scoring = await loadScoring();

    const matches: MatchScoringInput[] = [
      // predicted and exactly right
      { game_id: 'g1', prediction: { home: 2, away: 1 }, result: { home: 2, away: 1 } },
      // never predicted — AC-03's case
      { game_id: 'g2', prediction: null, result: { home: 0, away: 3 } },
    ];

    expect(scoring.scoreGameweek(matches)).toEqual({
      points: 5,
      scored_match_count: 1,
      correct_results_count: 1,
      exact_scores_count: 1,
    });
  });

  it('AC-04: a double gameweek sums both of a team’s matches into a single gameweek total', async () => {
    const scoring = await loadScoring();

    // Arsenal plays twice inside one official Premier League gameweek.
    const matches: MatchScoringInput[] = [
      { game_id: 'ars-1', prediction: { home: 2, away: 1 }, result: { home: 2, away: 1 } }, // exact -> 5
      { game_id: 'ars-2', prediction: { home: 1, away: 0 }, result: { home: 3, away: 0 } }, // outcome only -> 2
    ];

    expect(scoring.scoreGameweek(matches)).toEqual({
      points: 7,
      scored_match_count: 2,
      correct_results_count: 2,
      exact_scores_count: 1,
    });
  });

  it('AC-05: a blank gameweek (no fixture for the team) contributes nothing to the player’s score', async () => {
    const scoring = await loadScoring();

    // The team has no fixture, so it produces no MatchScoringInput at all.
    expect(scoring.scoreGameweek([])).toEqual({
      points: 0,
      scored_match_count: 0,
      correct_results_count: 0,
      exact_scores_count: 0,
    });
  });
});
