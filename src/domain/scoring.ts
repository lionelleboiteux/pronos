/**
 * Scoring calculator — pure, no DB/network (02-architecture.v1.md §1).
 *
 * Matrix confirmed by Lio: 5 exact score, 3 correct outcome + goal
 * difference, 2 correct outcome only, 0 otherwise.
 */

export type ScorePair = { home: number; away: number };

export type MatchScoringInput = {
  game_id: string;
  /** null when the player submitted no prediction for this match (AC-03). */
  prediction: ScorePair | null;
  /** null when no final result has been reported yet. */
  result: ScorePair | null;
};

export type GameweekTotal = {
  points: number;
  /** AC-03: matches with no prediction are excluded from this count. */
  scored_match_count: number;
  correct_results_count: number;
  exact_scores_count: number;
};

const EXACT_SCORE = 5;
const CORRECT_OUTCOME_AND_GOAL_DIFFERENCE = 3;
const CORRECT_OUTCOME = 2;
const NOTHING = 0;

const outcome = (pair: ScorePair): number => Math.sign(pair.home - pair.away);
const goalDifference = (pair: ScorePair): number => pair.home - pair.away;

export function scoreMatch(prediction: ScorePair | null, result: ScorePair | null): number {
  if (prediction === null || result === null) return NOTHING;
  if (prediction.home === result.home && prediction.away === result.away) return EXACT_SCORE;
  if (outcome(prediction) !== outcome(result)) return NOTHING;
  if (goalDifference(prediction) === goalDifference(result)) {
    return CORRECT_OUTCOME_AND_GOAL_DIFFERENCE;
  }
  return CORRECT_OUTCOME;
}

/** Sums every match in one gameweek into a single total (AC-04, AC-05). */
export function scoreGameweek(matches: MatchScoringInput[]): GameweekTotal {
  const total: GameweekTotal = {
    points: 0,
    scored_match_count: 0,
    correct_results_count: 0,
    exact_scores_count: 0,
  };

  for (const match of matches) {
    if (match.prediction === null) continue;
    const points = scoreMatch(match.prediction, match.result);
    total.points += points;
    total.scored_match_count += 1;
    if (points >= CORRECT_OUTCOME) total.correct_results_count += 1;
    if (points === EXACT_SCORE) total.exact_scores_count += 1;
  }

  return total;
}
