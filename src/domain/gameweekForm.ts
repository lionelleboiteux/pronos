/**
 * Form row generation — the shared authority the UI renders. A locked match is
 * never selectable, for every player, whether or not they already submitted
 * (AC-02). A team with no fixture simply has no row (AC-05).
 */

import { isLocked } from './lock.ts';
import type { ScorePair } from './scoring.ts';

export type FormGame = {
  id: string;
  home_team_code: string;
  away_team_code: string;
  starts_at: Date;
};

export type FormRow = {
  game_id: string;
  is_locked: boolean;
  selectable: boolean;
  my_prediction: ScorePair | null;
};

export function buildFormRows(
  now: Date,
  games: FormGame[],
  myPredictions: Record<string, ScorePair>,
): FormRow[] {
  return games.map((game) => {
    const locked = isLocked(now, game.starts_at);
    return {
      game_id: game.id,
      is_locked: locked,
      selectable: !locked,
      my_prediction: myPredictions[game.id] ?? null,
    };
  });
}
