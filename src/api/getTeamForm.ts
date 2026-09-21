/**
 * GET /v1/teams/form — last 5 league results (win/draw/loss) for one team,
 * oldest first. Backs fc-shared's <fc-team-form> widget, used across every
 * fantasy-coach.fr sibling site. `league` is a short code matching
 * `leagues.code` (e.g. "L1"), not a raw UUID, so the widget's public
 * markup stays a plain `<fc-team-form team="Marseille" league="L1">`.
 *
 * League matches only: cup/European competitions have no data source
 * anywhere in this schema (see 02-architecture.v1.md), so there is nothing
 * to filter out here — `games.league_id` already excludes them
 * structurally.
 */

import { errorResponse, type ApiResponse } from './errors.ts';

export type TeamFormResultEntry = {
  game_id: string;
  opponent_name: string;
  opponent_short_name: string | null;
  opponent_code: string | null;
  is_home: boolean;
  team_score: number;
  opponent_score: number;
  result: 'W' | 'D' | 'L';
  starts_at: Date;
};

export type TeamFormRecord = {
  team_name: string;
  short_name: string | null;
  code: string | null;
  results: TeamFormResultEntry[];
  updated_at: Date | null;
};

export type TeamFormDeps = {
  repo: {
    getTeamFormByShortName(league_code: string, short_name: string): Promise<TeamFormRecord | null>;
  };
};

export async function handleGetTeamForm(
  req: { league: string; name: string },
  deps: TeamFormDeps,
): Promise<ApiResponse> {
  const found = await deps.repo.getTeamFormByShortName(req.league, req.name);
  if (!found) {
    return errorResponse(404, 'NOT_FOUND', 'No team was found matching the given league and name.', {
      league: req.league,
      name: req.name,
    });
  }

  return {
    status: 200,
    body: {
      team_name: found.team_name,
      short_name: found.short_name,
      code: found.code,
      results: found.results.map((r) => ({
        game_id: r.game_id,
        opponent_name: r.opponent_name,
        opponent_short_name: r.opponent_short_name,
        opponent_code: r.opponent_code,
        is_home: r.is_home,
        team_score: r.team_score,
        opponent_score: r.opponent_score,
        result: r.result,
        starts_at: r.starts_at.toISOString(),
      })),
      updated_at: found.updated_at ? found.updated_at.toISOString() : null,
    },
  };
}
