/**
 * Gameweek transition tick — driven by pg_cron, with `now` injected so the
 * logic is exercised with synthetic timestamps rather than wall-clock waits
 * (02-architecture.v1.md §1). Each league is advanced independently (AC-07)
 * by the same code path, whether it is one of the original three or a 4th
 * added by configuration alone (AC-13).
 */

import { isLocked } from './lock.ts';
import { buildTelemetryEvent, type TelemetryEvent } from '../telemetry/events.ts';

export type MatchState = {
  id: string;
  starts_at: Date;
  /** Guards against re-emitting match_locked on every tick. */
  lock_event_emitted: boolean;
};

export type GameweekState = {
  id: string;
  number: number;
  matches: MatchState[];
  /**
   * Guards against re-emitting gameweek_closed on every tick while this
   * gameweek sits locked with no successor row yet (fixtures for the next
   * gameweek haven't been ingested). Mirrors MatchState.lock_event_emitted.
   */
  closed_event_emitted: boolean;
};

export type LeagueState = {
  league_id: string;
  league_code: string;
  current_gameweek_id: string | null;
  gameweeks: GameweekState[];
};

export type TickResult = {
  leagues: LeagueState[];
  events: TelemetryEvent[];
};

const lastKickoffOf = (gameweek: GameweekState): Date | null =>
  gameweek.matches.reduce<Date | null>(
    (latest, m) => (latest === null || m.starts_at > latest ? m.starts_at : latest),
    null,
  );

/** The next gameweek in play order, or null at the end of the season. */
const nextGameweekAfter = (league: LeagueState, closed: GameweekState): GameweekState | null =>
  league.gameweeks
    .filter((gw) => gw.number > closed.number)
    .sort((a, b) => a.number - b.number)[0] ?? null;

function advanceLeague(now: Date, league: LeagueState): { league: LeagueState; events: TelemetryEvent[] } {
  const occurred_at = now.toISOString();
  const events: TelemetryEvent[] = [];

  const gameweeks = league.gameweeks.map((gameweek) => ({
    ...gameweek,
    matches: gameweek.matches.map((m) => {
      if (m.lock_event_emitted || !isLocked(now, m.starts_at)) return m;
      events.push(
        buildTelemetryEvent('match_locked', {
          league: league.league_code,
          gameweek: gameweek.number,
          match_id: m.id,
          kickoff_time: m.starts_at.toISOString(),
          league_id: league.league_id,
          gameweek_id: gameweek.id,
          game_id: m.id,
          occurred_at,
        }),
      );
      return { ...m, lock_event_emitted: true };
    }),
  }));

  const current = gameweeks.find((gw) => gw.id === league.current_gameweek_id);
  const lastKickoff = current ? lastKickoffOf(current) : null;
  if (!current || lastKickoff === null || !isLocked(now, lastKickoff)) {
    return { league: { ...league, gameweeks }, events };
  }

  if (!current.closed_event_emitted) {
    events.push(
      buildTelemetryEvent('gameweek_closed', {
        league: league.league_code,
        gameweek: current.number,
        closed_at: occurred_at,
        league_id: league.league_id,
        gameweek_id: current.id,
        occurred_at,
      }),
    );
  }

  const next = nextGameweekAfter(league, current);
  if (!next) {
    // The next gameweek's fixtures haven't been ingested yet — stay put
    // rather than dropping current_gameweek_id to null. Nulling it here
    // would drop this league out of every future tick (it's only ever
    // looked up by current_gameweek_id) with no way back in: the fixture
    // sync also derives its target gameweek number from this same "current"
    // state, so once it goes null the pipeline can never discover the real
    // next gameweek to ingest either. Staying on the closed gameweek keeps
    // both sides of the pipeline talking until the next gameweek's row
    // shows up, at which point the branch below takes over.
    const closedGameweeks = gameweeks.map((gw) =>
      gw.id === current.id ? { ...gw, closed_event_emitted: true } : gw,
    );
    return { league: { ...league, gameweeks: closedGameweeks, current_gameweek_id: current.id }, events };
  }

  events.push(
    buildTelemetryEvent('gameweek_opened', {
      league: league.league_code,
      gameweek: next.number,
      opened_at: occurred_at,
      league_id: league.league_id,
      gameweek_id: next.id,
      occurred_at,
    }),
  );

  return { league: { ...league, gameweeks, current_gameweek_id: next.id }, events };
}

export function tick(now: Date, leagues: LeagueState[]): TickResult {
  const advanced = leagues.map((league) => advanceLeague(now, league));
  return {
    leagues: advanced.map((a) => a.league),
    events: advanced.flatMap((a) => a.events),
  };
}
