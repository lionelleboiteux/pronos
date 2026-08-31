import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepository } from '../../src/db/repository.js';
import { seedLeague, seedPlayer, insertPrediction, startTestDatabase, type TestDatabase } from '../support/pg.js';

/**
 * `applyAction('open', ...)` against real Postgres — the admin recovery path
 * for a league whose `current_gameweek_id` is stuck or null (adminOverride.ts's
 * own docstring: "never opened yet"). Confirmed live on La Liga: an admin
 * `open` straight onto gameweek 2 (recovering the null-current_gameweek_id
 * stall from CHANGELOG "Gameweek Transition Dead End") jumped
 * `current_gameweek_id` there directly, without ever emitting gameweek 1's
 * `gameweek_closed` event — so gameweek 1, fully played (10/10 matches
 * finished), was never scored and stayed permanently missing from the
 * classement. `closeSkippedGameweeks` (repository.ts) now closes and scores
 * every earlier unclosed gameweek in the season before the jump.
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

describe('admin open override backfills gameweeks it jumps past', () => {
  it('closes and scores an earlier, fully-finished gameweek that was never closed, before opening a later one', async () => {
    const { client } = db();
    const repo = createRepository(client);
    // seedLeague's gameweek is number 15, fully in the past, with one match.
    const ids = await seedLeague(client, { code: 'ob-1', name: 'Open Backfill League 1' });
    const player = await seedPlayer(client, 'BackfillPlayer1');
    await client.query(`update games set status = 'finished', home_team_score = 2, away_team_score = 1 where id = $1`, [
      ids.game_id,
    ]);
    await insertPrediction(client, ids, player, 2, 1); // exact score, 5 points

    // A later gameweek in the same season — the one the admin is about to
    // jump straight to, exactly as happened live on La Liga.
    const gw16 = await client.query(
      `insert into gameweeks (season_id, league_id, number, starts_at) values ($1, $2, 16, '2026-08-17T19:00:00Z') returning id`,
      [ids.season_id, ids.league_id],
    );
    const gw16_id: string = gw16.rows[0].id;

    const outcome = await repo.applyAction('open', gw16_id);

    expect(outcome).toMatchObject({
      applied: true,
      current_gameweek_id_before: null,
      current_gameweek_id_after: gw16_id,
    });

    // Gameweek 15 — never explicitly closed — should now be closed and scored.
    const closedEvent = await client.query(
      `select 1 from telemetry_events where event_type = 'gameweek_closed' and gameweek_id = $1`,
      [ids.gameweek_id],
    );
    expect(closedEvent.rows).toHaveLength(1);

    const standing = await client.query(
      `select points from league_gameweek_standings where gameweek_id = $1 and player_id = $2`,
      [ids.gameweek_id, player],
    );
    expect(standing.rows).toEqual([{ points: 5 }]);
  });

  it('does not re-close or re-score a gameweek that was already closed', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seedLeague(client, { code: 'ob-2', name: 'Open Backfill League 2' });
    const player = await seedPlayer(client, 'BackfillPlayer2');
    await client.query(`update games set status = 'finished', home_team_score = 2, away_team_score = 1 where id = $1`, [
      ids.game_id,
    ]);
    await insertPrediction(client, ids, player, 2, 1);

    // Gameweek 15 already closed and scored normally, the way the automated
    // tick does it.
    await repo.runScoringForGameweek(ids.gameweek_id, new Date('2026-08-11T00:00:00Z'));
    await client.query(
      `insert into telemetry_events (id, event_type, league_id, gameweek_id, occurred_at, payload)
       values (gen_random_uuid(), 'gameweek_closed', $1, $2, now(), '{"league":"ob-2","gameweek":15,"closed_at":"2026-08-11T00:00:00Z"}'::jsonb)`,
      [ids.league_id, ids.gameweek_id],
    );

    const gw16 = await client.query(
      `insert into gameweeks (season_id, league_id, number, starts_at) values ($1, $2, 16, '2026-08-17T19:00:00Z') returning id`,
      [ids.season_id, ids.league_id],
    );
    const gw16_id: string = gw16.rows[0].id;

    await repo.applyAction('open', gw16_id);

    const closedEvents = await client.query(
      `select 1 from telemetry_events where event_type = 'gameweek_closed' and gameweek_id = $1`,
      [ids.gameweek_id],
    );
    expect(closedEvents.rows).toHaveLength(1); // still exactly one, not doubled

    const scoredEvents = await client.query(
      `select 1 from telemetry_events where event_type = 'scoring_run_completed' and gameweek_id = $1`,
      [ids.gameweek_id],
    );
    expect(scoredEvents.rows).toHaveLength(1); // not re-scored
  });
});
