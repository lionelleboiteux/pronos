import { describe, it, expect } from 'vitest';
import { loadGameweekTransition } from '../support/seams.js';
import {
  GW15_LAST_KICKOFF,
  THE_THREE_LEAGUES,
  leagueWithGw15Open,
  t,
  threeLeaguesWithGw15Open,
} from '../support/fixtures.js';

/**
 * Gameweek transition tick — 02-architecture.v1.md §1, seam:
 * "inject `now` into the tick function rather than calling the clock
 * directly, so pg_cron-triggered logic can be exercised with synthetic
 * timestamps".
 */

const AFTER_LAST_KICKOFF = new Date(GW15_LAST_KICKOFF.getTime() + 60_000);
const BEFORE_LAST_KICKOFF = new Date(GW15_LAST_KICKOFF.getTime() - 60_000);

const currentOf = (leagues: ReturnType<typeof threeLeaguesWithGw15Open>, code: string) =>
  leagues.find((l) => l.league_code === code)!.current_gameweek_id;

describe('gameweek transition tick', () => {
  it('AC-06: when gameweek 15’s last scheduled kickoff passes, gameweek 15 closes to new predictions', async () => {
    const transition = await loadGameweekTransition();

    const result = transition.tick(AFTER_LAST_KICKOFF, [
      leagueWithGw15Open(THE_THREE_LEAGUES[0].id, 'ligue-1'),
    ]);

    expect(
      result.events
        .filter((e) => e.event_type === 'gameweek_closed')
        .map((e) => e.gameweek_id),
    ).toEqual(['ligue-1-gw15']);
  });

  it('AC-06: when gameweek 15 closes, gameweek 16 becomes the open gameweek for that league', async () => {
    const transition = await loadGameweekTransition();

    const result = transition.tick(AFTER_LAST_KICKOFF, [
      leagueWithGw15Open(THE_THREE_LEAGUES[0].id, 'ligue-1'),
    ]);

    expect(result.leagues[0].current_gameweek_id).toBe('ligue-1-gw16');
  });

  it('AC-06: before gameweek 15’s last kickoff passes, gameweek 15 stays open', async () => {
    const transition = await loadGameweekTransition();

    const result = transition.tick(BEFORE_LAST_KICKOFF, [
      leagueWithGw15Open(THE_THREE_LEAGUES[0].id, 'ligue-1'),
    ]);

    expect(result.leagues[0].current_gameweek_id).toBe('ligue-1-gw15');
  });

  // AC-07 applies independently to all three leagues: whichever one
  // transitions, the other two must be untouched.
  it.each(
    THE_THREE_LEAGUES.map(
      (l) =>
        [
          `AC-07: a gameweek transition in ${l.name} leaves the other two leagues’ open gameweek unchanged`,
          l.code,
        ] as const,
    ),
  )('%s', async (_title, code) => {
      const transition = await loadGameweekTransition();

      // Only the transitioning league's last match has kicked off; the other
      // two leagues' gameweek 15 last matches are still in the future.
      const leagues = threeLeaguesWithGw15Open().map((l) =>
        l.league_code === code
          ? l
          : {
              ...l,
              gameweeks: l.gameweeks.map((gw) =>
                gw.number === 15
                  ? {
                      ...gw,
                      matches: gw.matches.map((m) => ({
                        ...m,
                        starts_at: t('2026-09-01T20:00:00Z'),
                      })),
                    }
                  : gw,
              ),
            },
      );

      const result = transition.tick(AFTER_LAST_KICKOFF, leagues);

      const others = THE_THREE_LEAGUES.filter((l) => l.code !== code).map((l) => l.code);
      expect(others.map((c) => currentOf(result.leagues, c))).toEqual(
        others.map((c) => `${c}-gw15`),
      );
    },
  );
});
