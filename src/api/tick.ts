/**
 * POST /v1/internal/tick — the pg_cron/pg_net entry point into
 * `gameweekTransition.tick()` (02-architecture.v1.md §1) that was never
 * wired up in production: the transition logic has existed as a tested pure
 * function since the initial build, but nothing called it on a schedule, so
 * a league's current gameweek never actually closed or advanced no matter
 * how long ago its last match kicked off (see README "Current Status").
 *
 * Also runs the scoring engine for any gameweek that closes this tick — the
 * same gap as above, one step further down the pipeline: `runScoring()` has
 * existed as tested logic since the initial build, but was only ever wired
 * to the manual admin "rescore" action, never to an automatic post-close
 * trigger, so a closed gameweek's classement stayed empty until an operator
 * rescored it by hand.
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
    /** No-ops if this gameweek already has a scoring_run_completed event. */
    runScoringForGameweek(gameweek_id: string, now: Date): Promise<void>;
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

  const closedGameweekIds = result.events
    .filter((e) => e.event_type === 'gameweek_closed')
    .map((e) => e.gameweek_id)
    .filter((id): id is string => id !== null);
  for (const gameweek_id of closedGameweekIds) {
    await deps.repo.runScoringForGameweek(gameweek_id, now);
  }

  // Only leagues whose current_gameweek_id actually moved this tick need it
  // written back — everyone else (still open, or with no current gameweek to
  // begin with) is untouched. A gameweek can close without opening a
  // successor (its next gameweek's fixtures haven't been ingested yet —
  // gameweekTransition.tick() then holds current_gameweek_id on the closed
  // gameweek rather than nulling it, so the league stays reachable on future
  // ticks); that still needs writing back the first time it happens, and the
  // eventual transition to the next gameweek — once its row exists — arrives
  // as a gameweek_opened event with no accompanying gameweek_closed, since
  // it was already emitted on the tick that closed it.
  const changedLeagueIds = new Set(
    result.events
      .filter((e) => e.event_type === 'gameweek_closed' || e.event_type === 'gameweek_opened')
      .map((e) => e.league_id),
  );
  for (const league of result.leagues) {
    if (changedLeagueIds.has(league.league_id)) {
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
