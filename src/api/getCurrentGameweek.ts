/**
 * GET /v1/leagues/{leagueId}/current — the read that drives the player form.
 *
 * `is_locked` is computed here, never cached. `my_prediction` carries only the
 * requester's own pick, matched by exact pseudo; no other player's pick is
 * reachable anywhere in the response (NFR-DISCLOSE-01/02).
 */

import { isLocked } from '../domain/lock.ts';
import { errorResponse, type ApiResponse } from './errors.ts';

export type StoredPrediction = {
  pseudo: string;
  game_id: string;
  predicted_home_score: number;
  predicted_away_score: number;
  submitted_at: Date;
};

export type TeamRecord = { id: string; name: string; code: string; logo_url: string | null };

export type LeagueCurrentState = {
  league: { id: string; code: string; name: string; logo_url: string | null };
  season_id: string | null;
  gameweek: {
    id: string;
    number: number;
    starts_at: Date;
    ends_at: Date | null;
    stage_name: string | null;
  } | null;
  games: Array<{
    id: string;
    home_team: TeamRecord;
    away_team: TeamRecord;
    starts_at: Date;
    status: string;
    home_team_score: number | null;
    away_team_score: number | null;
  }>;
  /** Every prediction stored for this gameweek, across all players. */
  predictions: StoredPrediction[];
};

export type CurrentGameweekDeps = {
  now(): Date;
  repo: {
    getLeagueCurrentState(league_id: string): Promise<LeagueCurrentState | null>;
  };
};

export async function handleGetCurrentGameweek(
  req: { league_id: string; pseudo?: string },
  deps: CurrentGameweekDeps,
): Promise<ApiResponse> {
  const state = await deps.repo.getLeagueCurrentState(req.league_id);
  if (!state) {
    return errorResponse(404, 'NOT_FOUND', 'No league was found matching the given identifier.', {
      league_id: req.league_id,
    });
  }

  const now = deps.now();
  const mine = new Map(
    req.pseudo === undefined
      ? []
      : state.predictions.filter((p) => p.pseudo === req.pseudo).map((p) => [p.game_id, p] as const),
  );

  return {
    status: 200,
    body: {
      league: state.league,
      season_id: state.season_id,
      gameweek: state.gameweek && {
        id: state.gameweek.id,
        number: state.gameweek.number,
        starts_at: state.gameweek.starts_at.toISOString(),
        ends_at: state.gameweek.ends_at?.toISOString() ?? null,
        stage_name: state.gameweek.stage_name,
      },
      games: state.games.map((game) => {
        const own = mine.get(game.id);
        return {
          game: {
            id: game.id,
            home_team: game.home_team,
            away_team: game.away_team,
            starts_at: game.starts_at.toISOString(),
            status: game.status,
            home_team_score: game.home_team_score,
            away_team_score: game.away_team_score,
          },
          is_locked: isLocked(now, game.starts_at),
          my_prediction: own
            ? {
                game_id: own.game_id,
                predicted_home_score: own.predicted_home_score,
                predicted_away_score: own.predicted_away_score,
                submitted_at: own.submitted_at.toISOString(),
              }
            : null,
        };
      }),
    },
  };
}
