/**
 * Morning-after scoring run (AC-08, AC-14) — the pg_cron job that turns a
 * finished gameweek into a classement. `now` is injected, and the run is a
 * no-op once its scoring_run_completed event already exists, so a retried
 * cron tick cannot update the classement twice.
 *
 * Readiness is `all_games_finished`, not kickoff time: a gameweek closes to
 * new predictions the instant its last match kicks off (see lock.ts), but a
 * match can run for ~2 hours after that before a final score exists. Scoring
 * against kickoff time alone would compute against whatever placeholder
 * result happened to be in the database at that instant — the caller
 * (repository.ts) is responsible for checking every game's status is
 * actually 'finished' before calling this with `all_games_finished: true`,
 * and for retrying on a later tick if it isn't yet (src/api/tick.ts).
 */

import { scoreGameweek, type MatchScoringInput } from './scoring.ts';
import { buildTelemetryEvent, type TelemetryEvent } from '../telemetry/events.ts';

export type ScoringRunPlayer = {
  player_id: string;
  pseudo: string;
  matches: MatchScoringInput[];
};

export type ScoringRunInput = {
  now: Date;
  league_id: string;
  gameweek_id: string;
  /** True once every game in the gameweek has a final result (games.status = 'finished'). */
  all_games_finished: boolean;
  /** True when a scoring_run_completed event already exists for this gameweek. */
  already_completed: boolean;
  players: ScoringRunPlayer[];
};

export type StandingsRow = {
  player_id: string;
  pseudo: string;
  points: number;
  rank: number;
  predictions_count: number;
  correct_results_count: number;
  exact_scores_count: number;
};

export type ScoringRunOutput = {
  ran: boolean;
  skipped_reason?: 'already_completed' | 'gameweek_not_finished';
  standings: StandingsRow[];
  players_scored_count: number;
  events: TelemetryEvent[];
};

const skipped = (reason: 'already_completed' | 'gameweek_not_finished'): ScoringRunOutput => ({
  ran: false,
  skipped_reason: reason,
  standings: [],
  players_scored_count: 0,
  events: [],
});

/** Standard competition ranking: equal point totals share the better rank. */
function rank(
  scored: Array<Omit<StandingsRow, 'rank'>>,
): StandingsRow[] {
  const ordered = [...scored].sort((a, b) => b.points - a.points);
  let currentRank = 0;
  let previousPoints: number | null = null;
  return ordered.map((row, index) => {
    if (previousPoints === null || row.points !== previousPoints) {
      currentRank = index + 1;
      previousPoints = row.points;
    }
    return { ...row, rank: currentRank };
  });
}

export function runScoring(input: ScoringRunInput): ScoringRunOutput {
  if (input.already_completed) return skipped('already_completed');
  if (!input.all_games_finished) return skipped('gameweek_not_finished');

  const standings = rank(
    input.players.map((player) => {
      const total = scoreGameweek(player.matches);
      return {
        player_id: player.player_id,
        pseudo: player.pseudo,
        points: total.points,
        predictions_count: total.scored_match_count,
        correct_results_count: total.correct_results_count,
        exact_scores_count: total.exact_scores_count,
      };
    }),
  );

  return {
    ran: true,
    standings,
    players_scored_count: standings.length,
    events: [
      buildTelemetryEvent('scoring_run_completed', {
        league: input.league_id,
        gameweek: input.gameweek_id,
        run_at: input.now.toISOString(),
        players_scored_count: standings.length,
        league_id: input.league_id,
        gameweek_id: input.gameweek_id,
        occurred_at: input.now.toISOString(),
      }),
    ],
  };
}
