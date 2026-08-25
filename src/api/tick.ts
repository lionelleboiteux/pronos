/**
 * POST /v1/internal/tick — the pg_cron/pg_net entry point into
 * `gameweekTransition.tick()` (02-architecture.v1.md §1) that was never
 * wired up in production: the transition logic has existed as a tested pure
 * function since the initial build, but nothing called it on a schedule, so
 * a league's current gameweek never actually closed or advanced no matter
 * how long ago its last match kicked off (see README "Current Status").
 *
 * Same trust tier as /v1/ingest/fixtures: a machine-to-machine credential
 * held by the scheduled caller (here, a secret in Supabase Vault that the
 * pg_cron job reads to set its Authorization header), not a human
 * operator's ADMIN_TOKEN.
 */

import { tick, type LeagueState, type TickResult } from '../domain/gameweekTransition.ts';
import { errorResponse, type ApiResponse } from './errors.ts';

export type TickRequest = {
  authorization: string | null;
};

export type TickDeps = {
  now(): Date;
  auth: { verifyBearer(token: string | null): Promise<{ valid: boolean }> };
  repo: {
    /** Every league's current gameweek plus the next one already on record, if any. */
    listOpenGameweekStates(): Promise<LeagueState[]>;
    insertTelemetryEvents(events: TickResult['events']): Promise<void>;
    setCurrentGameweek(league_id: string, gameweek_id: string | null): Promise<void>;
  };
};

const bearerToken = (header: string | null): string | null => {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  return match ? (match[1] as string) : null;
};

export async function handleTick(req: TickRequest, deps: TickDeps): Promise<ApiResponse> {
  const session = await deps.auth.verifyBearer(bearerToken(req.authorization));
  if (!session.valid) {
    return errorResponse(401, 'UNAUTHORIZED', 'A valid tick bearer token is required for this endpoint.');
  }

  const now = deps.now();
  const before = await deps.repo.listOpenGameweekStates();
  const result = tick(now, before);

  await deps.repo.insertTelemetryEvents(result.events);

  // Only leagues whose current gameweek actually closed this tick need their
  // `leagues.current_gameweek_id` written back — everyone else (still open,
  // or with no current gameweek to begin with) is untouched, so a league
  // stuck for lack of a next-gameweek row (no ingested fixtures yet) is left
  // exactly as `applyAction`'s manual 'close' path already leaves it, not
  // silently reset.
  const closedLeagueIds = new Set(
    result.events.filter((e) => e.event_type === 'gameweek_closed').map((e) => e.league_id),
  );
  for (const league of result.leagues) {
    if (closedLeagueIds.has(league.league_id)) {
      await deps.repo.setCurrentGameweek(league.league_id, league.current_gameweek_id);
    }
  }

  return {
    status: 200,
    body: {
      leagues_processed: result.leagues.length,
      events_emitted: result.events.length,
      events: result.events.map((e) => ({
        event_type: e.event_type,
        league_id: e.league_id,
        gameweek_id: e.gameweek_id,
      })),
    },
  };
}
