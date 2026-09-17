import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepository } from '../../src/db/repository.js';
import { seedLeague, seedPlayer, startTestDatabase, type TestDatabase } from '../support/pg.js';

/**
 * `players.email` has existed since the initial schema but nothing ever
 * wrote to it — AC-12's receipt is a fire-and-forget side effect, not a
 * write to the player row. `upsertPrediction` now persists a submitted
 * email onto the player exactly like the pseudo already is: an upsert keyed
 * on identity, best-effort so a collision on the separate `email` unique
 * constraint (two pseudos legitimately sharing a mailbox, since there are
 * no accounts) degrades to a silent no-op instead of failing the
 * submission it rides along with.
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

describe('upsertPrediction persists email the same way it persists pseudo', () => {
  it('stores the email on the player row on first submission', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seedLeague(client, { code: 'pe-1', name: 'Prediction Email League 1' });

    const { player_id } = await repo.upsertPrediction({
      pseudo: 'EmailPlayer1',
      game_id: ids.game_id,
      predicted_home_score: 1,
      predicted_away_score: 0,
      email: 'player1@example.com',
    });

    const row = await client.query(`select email from players where id = $1`, [player_id]);
    expect(row.rows[0].email).toBe('player1@example.com');
  });

  it('updates the stored email on a resubmit with a new address, same as the pseudo path', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seedLeague(client, { code: 'pe-2', name: 'Prediction Email League 2' });

    const first = await repo.upsertPrediction({
      pseudo: 'EmailPlayer2',
      game_id: ids.game_id,
      predicted_home_score: 1,
      predicted_away_score: 0,
      email: 'old@example.com',
    });
    await repo.upsertPrediction({
      pseudo: 'EmailPlayer2',
      game_id: ids.game_id,
      predicted_home_score: 2,
      predicted_away_score: 0,
      email: 'new@example.com',
    });

    const row = await client.query(`select email from players where id = $1`, [first.player_id]);
    expect(row.rows[0].email).toBe('new@example.com');
  });

  it('leaves the player email untouched when no email is submitted', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seedLeague(client, { code: 'pe-3', name: 'Prediction Email League 3' });

    const { player_id } = await repo.upsertPrediction({
      pseudo: 'EmailPlayer3',
      game_id: ids.game_id,
      predicted_home_score: 1,
      predicted_away_score: 0,
    });

    const row = await client.query(`select email from players where id = $1`, [player_id]);
    expect(row.rows[0].email).toBeNull();
  });

  it('does not fail the submission or steal the email when it already belongs to a different player', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seedLeague(client, { code: 'pe-4', name: 'Prediction Email League 4' });
    const owner_id = await seedPlayer(client, 'EmailOwner4', 'shared@example.com');

    const { player_id } = await repo.upsertPrediction({
      pseudo: 'EmailPlayer4',
      game_id: ids.game_id,
      predicted_home_score: 1,
      predicted_away_score: 0,
      email: 'shared@example.com',
    });

    expect(player_id).not.toBe(owner_id);
    const rows = await client.query(`select id, email from players where id in ($1, $2)`, [
      owner_id,
      player_id,
    ]);
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.email]));
    expect(byId[owner_id]).toBe('shared@example.com');
    expect(byId[player_id]).toBeNull();
  });
});
