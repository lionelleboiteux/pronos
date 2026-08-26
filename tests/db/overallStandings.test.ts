import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepository } from '../../src/db/repository.js';
import { seedLeague, seedPlayer, insertPrediction, startTestDatabase, type TestDatabase } from '../support/pg.js';

/**
 * `overall_standings` — the season-long classement `GET .../standings/overall`
 * serves, and what the frontend's main "classement général" card reads. A
 * separate table from `league_gameweek_standings`: nothing in the codebase
 * ever wrote to it until `repository.ts`'s `refreshOverallStandings()`, so
 * gameweeks scored correctly but the season total stayed permanently empty.
 * Exercised here via `runScoringForGameweek` — the same call
 * `src/api/tick.ts` makes on every automatic gameweek close.
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

describe('overall_standings refresh', () => {
  it('is populated the first time a gameweek is scored, not left empty', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seedLeague(client, { code: 'os-1', name: 'Overall League 1', kickoff: '2026-08-10T19:00:00Z' });
    const player = await seedPlayer(client, 'OverallPlayer1');
    await client.query(`update games set status = 'finished', home_team_score = 2, away_team_score = 1 where id = $1`, [
      ids.game_id,
    ]);
    await insertPrediction(client, ids, player, 2, 1); // exact score, 5 points

    await repo.runScoringForGameweek(ids.gameweek_id, new Date('2026-08-11T00:00:00Z'));

    const page = await repo.getOverallStandings(ids.season_id, { page: 1, per_page: 20 });
    expect(page.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ pseudo: 'OverallPlayer1', points: 5, rank: 1 })]),
    );
  });

  it('sums a player’s points across every scored gameweek in the season, not just the latest', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seedLeague(client, { code: 'os-2', name: 'Overall League 2', kickoff: '2026-08-10T19:00:00Z' });
    const player = await seedPlayer(client, 'OverallPlayer2');
    await client.query(`update games set status = 'finished', home_team_score = 1, away_team_score = 1 where id = $1`, [
      ids.game_id,
    ]);
    await insertPrediction(client, ids, player, 1, 1); // exact, 5 points
    await repo.runScoringForGameweek(ids.gameweek_id, new Date('2026-08-11T00:00:00Z'));

    // A second gameweek in the same season, scored a week later.
    const gw2 = await client.query(
      `insert into gameweeks (season_id, league_id, number, starts_at) values ($1, $2, 2, '2026-08-17T19:00:00Z') returning id`,
      [ids.season_id, ids.league_id],
    );
    const gw2_id: string = gw2.rows[0].id;
    const game2 = await client.query(
      `insert into games (season_id, league_id, gameweek_id, home_team_id, away_team_id, starts_at, status, home_team_score, away_team_score)
       values ($1, $2, $3, $4, $5, '2026-08-17T19:00:00Z', 'finished', 3, 0) returning id`,
      [ids.season_id, ids.league_id, gw2_id, ids.home_team_id, ids.away_team_id],
    );
    await client.query(
      `insert into predictions (player_id, game_id, gameweek_id, season_id, league_id, pred_home_team_score, pred_away_team_score)
       values ($1, $2, $3, $4, $5, 2, 0)`, // correct result (home win), wrong goal difference: 2 points
      [player, game2.rows[0].id, gw2_id, ids.season_id, ids.league_id],
    );

    await repo.runScoringForGameweek(gw2_id, new Date('2026-08-18T00:00:00Z'));

    const page = await repo.getOverallStandings(ids.season_id, { page: 1, per_page: 20 });
    expect(page.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pseudo: 'OverallPlayer2',
          points: 7, // 5 (exact, gw1) + 2 (correct result only, gw2)
          predictions_count: 2,
          correct_results_count: 2,
          exact_scores_count: 1,
        }),
      ]),
    );
  });

  it('is idempotent: calling runScoringForGameweek again does not double-count', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seedLeague(client, { code: 'os-3', name: 'Overall League 3', kickoff: '2026-08-10T19:00:00Z' });
    const player = await seedPlayer(client, 'OverallPlayer3');
    await client.query(`update games set status = 'finished', home_team_score = 2, away_team_score = 1 where id = $1`, [
      ids.game_id,
    ]);
    await insertPrediction(client, ids, player, 2, 1);

    const now = new Date('2026-08-11T00:00:00Z');
    await repo.runScoringForGameweek(ids.gameweek_id, now);
    await repo.runScoringForGameweek(ids.gameweek_id, now);

    const page = await repo.getOverallStandings(ids.season_id, { page: 1, per_page: 20 });
    expect(page.rows.filter((r) => r.pseudo === 'OverallPlayer3')).toEqual([
      expect.objectContaining({ pseudo: 'OverallPlayer3', points: 5 }),
    ]);
  });
});
