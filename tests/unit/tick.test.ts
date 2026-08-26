import { describe, it, expect } from 'vitest';
import { handleTick, type TickDeps } from '../../src/api/tick.ts';
import type { LeagueState } from '../../src/domain/gameweekTransition.ts';
import { t } from '../support/fixtures.js';

/**
 * POST /v1/internal/tick — the pg_cron/pg_net entry point into the
 * already-tested gameweekTransition.tick() (see tests/unit/gameweekTransition.test.ts
 * for the transition rules themselves). These tests cover only what this
 * handler adds on top: auth, and persisting tick()'s outcome back through
 * the repo seam.
 */

const LAST_KICKOFF = t('2026-08-11T20:00:00Z');
const AFTER = t('2026-08-11T20:05:00Z');
const BEFORE = t('2026-08-11T19:55:00Z');

function leagueOpenOnGw1(): LeagueState {
  return {
    league_id: 'league-pl',
    league_code: 'PL',
    current_gameweek_id: 'gw1',
    gameweeks: [
      { id: 'gw1', number: 1, matches: [{ id: 'game1', starts_at: LAST_KICKOFF, lock_event_emitted: false }] },
      { id: 'gw2', number: 2, matches: [] },
    ],
  };
}

function buildDeps(opts: {
  now: Date;
  leagues: LeagueState[];
  tokenValid?: boolean;
}): {
  deps: TickDeps;
  inserted: unknown[];
  currentGameweekWrites: Array<{ league_id: string; gameweek_id: string | null }>;
  scoringRuns: string[];
} {
  const inserted: unknown[] = [];
  const currentGameweekWrites: Array<{ league_id: string; gameweek_id: string | null }> = [];
  const scoringRuns: string[] = [];
  const deps: TickDeps = {
    now: () => opts.now,
    auth: { verifyBearer: async () => ({ valid: opts.tokenValid ?? true }) },
    repo: {
      listOpenGameweekStates: async () => opts.leagues,
      insertTelemetryEvents: async (events) => void inserted.push(...events),
      setCurrentGameweek: async (league_id, gameweek_id) => {
        currentGameweekWrites.push({ league_id, gameweek_id });
      },
      runScoringForGameweek: async (gameweek_id) => {
        scoringRuns.push(gameweek_id);
      },
    },
  };
  return { deps, inserted, currentGameweekWrites, scoringRuns };
}

describe('POST /v1/internal/tick', () => {
  it('rejects a request with no valid tick bearer token', async () => {
    const { deps } = buildDeps({ now: AFTER, leagues: [leagueOpenOnGw1()], tokenValid: false });

    const res = await handleTick({ authorization: null }, deps);

    expect({ status: res.status, code: (res.body as any)?.error?.code }).toEqual({
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('does nothing to a league whose current gameweek has not fully kicked off yet', async () => {
    const { deps, inserted, currentGameweekWrites, scoringRuns } = buildDeps({
      now: BEFORE,
      leagues: [leagueOpenOnGw1()],
    });

    await handleTick({ authorization: 'Bearer valid' }, deps);

    expect(inserted).toHaveLength(0);
    expect(currentGameweekWrites).toHaveLength(0);
    expect(scoringRuns).toHaveLength(0);
  });

  it('runs scoring for a gameweek once it closes', async () => {
    const { deps, scoringRuns } = buildDeps({ now: AFTER, leagues: [leagueOpenOnGw1()] });

    await handleTick({ authorization: 'Bearer valid' }, deps);

    expect(scoringRuns).toEqual(['gw1']);
  });

  it('still runs scoring for a closed gameweek even when there is no next gameweek to open', async () => {
    const noNextYet: LeagueState = {
      league_id: 'league-bl1',
      league_code: 'BL1',
      current_gameweek_id: 'gw1',
      gameweeks: [
        { id: 'gw1', number: 1, matches: [{ id: 'game1', starts_at: LAST_KICKOFF, lock_event_emitted: false }] },
      ],
    };
    const { deps, scoringRuns } = buildDeps({ now: AFTER, leagues: [noNextYet] });

    await handleTick({ authorization: 'Bearer valid' }, deps);

    expect(scoringRuns).toEqual(['gw1']);
  });

  it('closes the current gameweek and opens the next one once the last kickoff has passed', async () => {
    const { deps, currentGameweekWrites } = buildDeps({ now: AFTER, leagues: [leagueOpenOnGw1()] });

    const res = await handleTick({ authorization: 'Bearer valid' }, deps);

    expect(currentGameweekWrites).toEqual([{ league_id: 'league-pl', gameweek_id: 'gw2' }]);
    expect((res.body as any).events_emitted).toBeGreaterThanOrEqual(2);
  });

  it('records the events from tick() in its response, including match_locked, gameweek_closed and gameweek_opened', async () => {
    const { deps } = buildDeps({ now: AFTER, leagues: [leagueOpenOnGw1()] });

    const res = await handleTick({ authorization: 'Bearer valid' }, deps);

    const eventTypes = (res.body as any).events.map((e: { event_type: string }) => e.event_type);
    expect(eventTypes).toEqual(
      expect.arrayContaining(['match_locked', 'gameweek_closed', 'gameweek_opened']),
    );
  });

  it('leaves a league with no next gameweek on record with a null current gameweek, rather than guessing one', async () => {
    const noNextYet: LeagueState = {
      league_id: 'league-bl1',
      league_code: 'BL1',
      current_gameweek_id: 'gw1',
      gameweeks: [
        { id: 'gw1', number: 1, matches: [{ id: 'game1', starts_at: LAST_KICKOFF, lock_event_emitted: false }] },
      ],
    };
    const { deps, currentGameweekWrites } = buildDeps({ now: AFTER, leagues: [noNextYet] });

    await handleTick({ authorization: 'Bearer valid' }, deps);

    expect(currentGameweekWrites).toEqual([{ league_id: 'league-bl1', gameweek_id: null }]);
  });

  it('leaves other leagues untouched when only one of them transitions', async () => {
    const stillOpen: LeagueState = {
      league_id: 'league-sa',
      league_code: 'SA',
      current_gameweek_id: 'gw1-sa',
      gameweeks: [
        {
          id: 'gw1-sa',
          number: 1,
          matches: [{ id: 'game-sa', starts_at: t('2026-08-18T20:00:00Z'), lock_event_emitted: false }],
        },
      ],
    };
    const { deps, currentGameweekWrites } = buildDeps({ now: AFTER, leagues: [leagueOpenOnGw1(), stillOpen] });

    await handleTick({ authorization: 'Bearer valid' }, deps);

    expect(currentGameweekWrites).toEqual([{ league_id: 'league-pl', gameweek_id: 'gw2' }]);
  });
});
