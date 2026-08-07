import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepository } from '../../src/db/repository.js';
import { seedLeague, seedPlayer, upsertPrediction, startTestDatabase, type TestDatabase } from '../support/pg.js';

/**
 * repository.getPlayerGameweekPicks against real Postgres — the consolidated
 * email receipt's data source (pdlc/jeu-des-pronos/12-email-receipt.v1.md).
 * The unit tests in sendGameweekReceipt.test.ts fake this function entirely;
 * this file is what actually proves the SQL joins are correct, since
 * Postgres's own behaviour is never mocked in this suite (see
 * tests/db/schema.test.ts's header comment).
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

describe('getPlayerGameweekPicks', () => {
  it('returns every match one pseudo picked in a gameweek, with team names and the league/gameweek label', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seedLeague(client, { code: 'gwp-1', name: 'GWP League One' });
    const player = await seedPlayer(client, 'GWPPlayer1');
    await upsertPrediction(client, ids, player, 2, 1);

    const result = await repo.getPlayerGameweekPicks(ids.league_id, ids.gameweek_id, 'GWPPlayer1');

    expect(result).toEqual({
      league_name: 'GWP League One',
      gameweek_number: 15,
      picks: [
        {
          home_team: 'gwp-1 Home FC',
          home_team_code: 'gwp-1-H',
          home_team_logo_url: null,
          away_team: 'gwp-1 Away FC',
          away_team_code: 'gwp-1-A',
          away_team_logo_url: null,
          predicted_home_score: 2,
          predicted_away_score: 1,
          starts_at: expect.any(Date),
        },
      ],
    });
  });

  it('returns only that pseudo’s picks, never another player’s', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seedLeague(client, { code: 'gwp-2', name: 'GWP League Two' });
    const me = await seedPlayer(client, 'GWPMe');
    const someoneElse = await seedPlayer(client, 'GWPSomeoneElse');
    await upsertPrediction(client, ids, me, 3, 0);
    await upsertPrediction(client, ids, someoneElse, 1, 1);

    const result = await repo.getPlayerGameweekPicks(ids.league_id, ids.gameweek_id, 'GWPMe');

    expect(result?.picks).toHaveLength(1);
    expect(result?.picks[0]).toMatchObject({ predicted_home_score: 3, predicted_away_score: 0 });
  });

  it('returns null when the gameweek does not belong to the given league', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seedLeague(client, { code: 'gwp-3', name: 'GWP League Three' });
    const otherLeague = await seedLeague(client, { code: 'gwp-4', name: 'GWP League Four' });
    const player = await seedPlayer(client, 'GWPMismatch');
    await upsertPrediction(client, ids, player, 1, 0);

    // ids.gameweek_id really belongs to ids.league_id, not otherLeague's.
    const result = await repo.getPlayerGameweekPicks(otherLeague.league_id, ids.gameweek_id, 'GWPMismatch');

    expect(result).toBeNull();
  });

  it('returns an empty picks array, not null, when the gameweek exists but this pseudo predicted nothing in it', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seedLeague(client, { code: 'gwp-5', name: 'GWP League Five' });

    const result = await repo.getPlayerGameweekPicks(ids.league_id, ids.gameweek_id, 'NeverSubmitted');

    expect(result).toEqual({ league_name: 'GWP League Five', gameweek_number: 15, picks: [] });
  });
});
