import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepository } from '../../src/db/repository.js';
import { seedLeague, seedPlayer, startTestDatabase, type BaselineIds, type TestDatabase } from '../support/pg.js';

/**
 * repository.getCrossLeagueWeeklyStandings against real Postgres — the
 * "European table" (one pseudo's points summed across every league for one
 * ISO calendar week, plus a running cumulative total). Leagues run
 * independent gameweek schedules with no shared numbering, so this proves
 * the calendar-week bucketing and the running-total window function against
 * production SQL, not a mock.
 *
 * The query deliberately has no league/season scope — it aggregates every
 * league_gameweek_standings row in the database — so every test below uses
 * its own non-overlapping pair of calendar weeks (this file shares one
 * Postgres instance across all its `it` blocks) and asserts by looking up
 * specific pseudos rather than comparing the whole result array, since other
 * tests' players legitimately show up too once any week is at or after their
 * own weeks.
 */

let started: TestDatabase | null = null;
let startupError: Error | null = null;

beforeAll(async () => {
  try {
    started = await startTestDatabase();
  } catch (err) {
    startupError = err as Error;
  }
}, 240_000);

afterAll(async () => {
  await started?.stop().catch(() => undefined);
});

function db(): TestDatabase {
  if (startupError) throw startupError;
  return started as TestDatabase;
}

/** All Mondays (2026-08-10 is ISO week 33); each test gets its own pair, 7+ days apart. */
const TEST1_WEEK = '2026-08-10'; // week 33
const TEST1_WEEK_WEDNESDAY = '2026-08-12T19:00:00Z'; // same ISO week as TEST1_WEEK
const TEST2_WEEK_A = '2026-08-17'; // week 34
const TEST2_WEEK_B = '2026-08-24'; // week 35
const TEST3_WEEK_A = '2026-08-31'; // week 36
const TEST3_WEEK_B = '2026-09-07'; // week 37
const TEST4_WEEK_A = '2026-09-14'; // week 38
const TEST4_WEEK_B = '2026-09-21'; // week 39

async function seedGameweekStanding(
  client: TestDatabase['client'],
  ids: BaselineIds,
  player_id: string,
  points: number,
): Promise<void> {
  await client.query(
    `insert into league_gameweek_standings
       (player_id, league_id, season_id, gameweek_id, points, rank, predictions_count, correct_results_count, exact_scores_count)
     values ($1, $2, $3, $4, $5, 1, 1, 1, 0)`,
    [player_id, ids.league_id, ids.season_id, ids.gameweek_id, points],
  );
}

describe('getCrossLeagueWeeklyStandings', () => {
  it('sums points from different leagues that fall in the same calendar week', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const leagueA = await seedLeague(client, { code: 'clw-a1', name: 'CLW League A1', kickoff: `${TEST1_WEEK}T19:00:00Z` });
    const leagueB = await seedLeague(client, { code: 'clw-b1', name: 'CLW League B1', kickoff: TEST1_WEEK_WEDNESDAY });
    const player = await seedPlayer(client, 'CLWPlayer1');

    await seedGameweekStanding(client, leagueA, player, 5);
    await seedGameweekStanding(client, leagueB, player, 3);

    const page = await repo.getCrossLeagueWeeklyStandings({ week: TEST1_WEEK, page: 1, per_page: 100 });

    expect(page.week_start).toBe(TEST1_WEEK);
    expect(page.rows.find((r) => r.pseudo === 'CLWPlayer1')).toMatchObject({
      points: 8,
      running_points: 8,
    });
  });

  it('carries the running total into a later week, and shows a 0-point row for a week the player did not score in', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const leagueA = await seedLeague(client, { code: 'clw-a2', name: 'CLW League A2', kickoff: `${TEST2_WEEK_A}T19:00:00Z` });
    const leagueC = await seedLeague(client, { code: 'clw-c2', name: 'CLW League C2', kickoff: `${TEST2_WEEK_B}T19:00:00Z` });
    const active = await seedPlayer(client, 'CLWPlayer2Active');
    const quiet = await seedPlayer(client, 'CLWPlayer2Quiet');

    // Both players score in week A; only `active` scores again in week B.
    await seedGameweekStanding(client, leagueA, active, 6);
    await seedGameweekStanding(client, leagueA, quiet, 4);
    await seedGameweekStanding(client, leagueC, active, 2);

    const weekA = await repo.getCrossLeagueWeeklyStandings({ week: TEST2_WEEK_A, page: 1, per_page: 100 });
    expect(weekA.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pseudo: 'CLWPlayer2Active', points: 6, running_points: 6 }),
        expect.objectContaining({ pseudo: 'CLWPlayer2Quiet', points: 4, running_points: 4 }),
      ]),
    );

    const weekB = await repo.getCrossLeagueWeeklyStandings({ week: TEST2_WEEK_B, page: 1, per_page: 100 });
    expect(weekB.week_start).toBe(TEST2_WEEK_B);
    expect(weekB.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pseudo: 'CLWPlayer2Active', points: 2, running_points: 8 }), // 6 + 2
        expect.objectContaining({ pseudo: 'CLWPlayer2Quiet', points: 0, running_points: 4 }), // silent, but week-A total carries forward
      ]),
    );
  });

  it('defaults to the most recent week with any data when no week is requested', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const leagueA = await seedLeague(client, { code: 'clw-a3', name: 'CLW League A3', kickoff: `${TEST3_WEEK_A}T19:00:00Z` });
    const leagueC = await seedLeague(client, { code: 'clw-c3', name: 'CLW League C3', kickoff: `${TEST3_WEEK_B}T19:00:00Z` });
    const player = await seedPlayer(client, 'CLWPlayer3');

    await seedGameweekStanding(client, leagueA, player, 5);
    await seedGameweekStanding(client, leagueC, player, 1);

    const page = await repo.getCrossLeagueWeeklyStandings({ week: null, page: 1, per_page: 100 });

    // The most recent week overall is >= TEST3_WEEK_B (this file only ever seeds forward).
    expect(page.week_start! >= TEST3_WEEK_B).toBe(true);
    if (page.week_start === TEST3_WEEK_B) {
      expect(page.rows.find((r) => r.pseudo === 'CLWPlayer3')).toMatchObject({ points: 1, running_points: 6 });
    }
  });

  it('ranks by the cumulative running total, not that single week’s points', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const leagueA = await seedLeague(client, { code: 'clw-a4', name: 'CLW League A4', kickoff: `${TEST4_WEEK_A}T19:00:00Z` });
    const leagueC = await seedLeague(client, { code: 'clw-c4', name: 'CLW League C4', kickoff: `${TEST4_WEEK_B}T19:00:00Z` });
    const earlyLeader = await seedPlayer(client, 'CLWEarlyLeader');
    const lateSurger = await seedPlayer(client, 'CLWLateSurger');

    await seedGameweekStanding(client, leagueA, earlyLeader, 10);
    await seedGameweekStanding(client, leagueA, lateSurger, 1);
    await seedGameweekStanding(client, leagueC, lateSurger, 20); // now leads 21 to 10

    const weekB = await repo.getCrossLeagueWeeklyStandings({ week: TEST4_WEEK_B, page: 1, per_page: 100 });

    const late = weekB.rows.find((r) => r.pseudo === 'CLWLateSurger');
    const early = weekB.rows.find((r) => r.pseudo === 'CLWEarlyLeader');
    expect(late).toMatchObject({ running_points: 21 });
    expect(early).toMatchObject({ running_points: 10 });
    expect(late!.rank).toBeLessThan(early!.rank);
  });

  it('returns an empty page, not an error, for a week nothing was scored in', async () => {
    const { client } = db();
    const repo = createRepository(client);

    const page = await repo.getCrossLeagueWeeklyStandings({ week: '2099-01-05', page: 1, per_page: 20 });

    expect(page).toEqual({ week_start: null, rows: [], total_items: 0 });
  });
});
