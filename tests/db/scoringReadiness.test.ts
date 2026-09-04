import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepository } from '../../src/db/repository.js';
import { seedLeague, seedPlayer, insertPrediction, startTestDatabase, type TestDatabase } from '../support/pg.js';

/**
 * `runScoringForGameweek`'s readiness gate against real Postgres — the fix
 * for a confirmed live bug: predictions lock the instant a gameweek's last
 * match kicks off (lock.ts), but the automated scoring run used to trigger
 * on that same signal. A match can run for ~2 hours after kickoff before a
 * final score exists, so the old gate could score a gameweek against
 * whatever placeholder `games.home_team_score`/`away_team_score` happened to
 * be in the database at that instant — confirmed live on Bundesliga
 * gameweek 1, where the persisted score (11) was computed minutes after
 * kickoff, hours before the real final scores (which gave 13) were
 * ingested. Scoring now additionally requires every game in the gameweek to
 * have `status = 'finished'` (src/domain/scoringRun.ts's `all_games_finished`).
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

describe('scoring readiness (all games finished, not just kickoff passed)', () => {
  it('does not score a gameweek while its only match is still unfinished, even though kickoff has passed', async () => {
    const { client } = db();
    const repo = createRepository(client);
    // seedLeague's game defaults to status 'scheduled' with no score — kickoff
    // (in the past, per its default) has passed but the match has not been
    // marked finished.
    const ids = await seedLeague(client, { code: 'sr-1', name: 'Scoring Readiness League 1' });
    const player = await seedPlayer(client, 'ReadinessPlayer1');
    await insertPrediction(client, ids, player, 2, 1);

    await repo.runScoringForGameweek(ids.gameweek_id, new Date('2026-08-11T00:00:00Z'));

    const standings = await client.query(
      `select * from league_gameweek_standings where gameweek_id = $1`,
      [ids.gameweek_id],
    );
    expect(standings.rows).toHaveLength(0);
    const events = await client.query(
      `select * from telemetry_events where event_type = 'scoring_run_completed' and gameweek_id = $1`,
      [ids.gameweek_id],
    );
    expect(events.rows).toHaveLength(0);
  });

  it('scores automatically once the match is marked finished, on a later retry', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seedLeague(client, { code: 'sr-2', name: 'Scoring Readiness League 2' });
    const player = await seedPlayer(client, 'ReadinessPlayer2');
    await insertPrediction(client, ids, player, 2, 1);

    // First attempt: still unfinished, no-ops (mirrors the automated tick
    // retrying every minute until games.status actually flips).
    await repo.runScoringForGameweek(ids.gameweek_id, new Date('2026-08-11T00:00:00Z'));

    await client.query(
      `update games set status = 'finished', home_team_score = 2, away_team_score = 1 where id = $1`,
      [ids.game_id],
    );
    await repo.runScoringForGameweek(ids.gameweek_id, new Date('2026-08-11T00:05:00Z'));

    const standings = await client.query(
      `select points from league_gameweek_standings where gameweek_id = $1 and player_id = $2`,
      [ids.gameweek_id, player],
    );
    expect(standings.rows).toEqual([{ points: 5 }]); // exact score
  });

  it('waits for every game in the gameweek to finish, not just the first one', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seedLeague(client, { code: 'sr-3', name: 'Scoring Readiness League 3' });
    const player = await seedPlayer(client, 'ReadinessPlayer3');

    // A second match in the same gameweek, teams reversed (still distinct
    // home/away per chk_different_teams).
    const game2 = await client.query(
      `insert into games (season_id, league_id, gameweek_id, home_team_id, away_team_id, starts_at)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [ids.season_id, ids.league_id, ids.gameweek_id, ids.away_team_id, ids.home_team_id, '2026-08-10T19:00:00Z'],
    );
    const game2_id: string = game2.rows[0].id;

    await insertPrediction(client, ids, player, 2, 1);
    await client.query(
      `insert into predictions (player_id, game_id, gameweek_id, season_id, league_id, pred_home_team_score, pred_away_team_score)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [player, game2_id, ids.gameweek_id, ids.season_id, ids.league_id, 1, 1],
    );

    // Finish only the first game — the gameweek should still be withheld.
    await client.query(
      `update games set status = 'finished', home_team_score = 2, away_team_score = 1 where id = $1`,
      [ids.game_id],
    );
    await repo.runScoringForGameweek(ids.gameweek_id, new Date('2026-08-11T00:00:00Z'));

    let standings = await client.query(
      `select 1 from league_gameweek_standings where gameweek_id = $1`,
      [ids.gameweek_id],
    );
    expect(standings.rows).toHaveLength(0);

    // Finish the second game too — now it should score both matches.
    await client.query(
      `update games set status = 'finished', home_team_score = 1, away_team_score = 1 where id = $1`,
      [game2_id],
    );
    await repo.runScoringForGameweek(ids.gameweek_id, new Date('2026-08-11T00:05:00Z'));

    standings = await client.query(
      `select points from league_gameweek_standings where gameweek_id = $1 and player_id = $2`,
      [ids.gameweek_id, player],
    );
    expect(standings.rows).toEqual([{ points: 10 }]); // 5 (exact) + 5 (exact)
  });
});

describe('automatic rescoring after a retroactive prediction backfill (no manual admin rescore needed)', () => {
  it('runScoringForGameweek rescores once a prediction is inserted directly into Postgres after the gameweek was already scored', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seedLeague(client, { code: 'sr-4', name: 'Scoring Readiness League 4' });
    await client.query(
      `update games set status = 'finished', home_team_score = 2, away_team_score = 1 where id = $1`,
      [ids.game_id],
    );
    const player1 = await seedPlayer(client, 'ReadinessPlayer4a');
    await insertPrediction(client, ids, player1, 2, 1); // exact, 5 points
    // Pin this "normal" prediction's updated_at into the fictional past —
    // insertPrediction otherwise leaves it at Postgres's real wall-clock
    // now(), which would already postdate the fixed 2026 dates used below.
    // Production has no such gap: every timestamp involved there comes from
    // the same real clock.
    await client.query(`update predictions set updated_at = $1 where player_id = $2 and game_id = $3`, [
      new Date('2026-08-10T18:00:00Z'),
      player1,
      ids.game_id,
    ]);

    await repo.runScoringForGameweek(ids.gameweek_id, new Date('2026-08-11T00:00:00Z'));

    let standings = await client.query(
      `select player_id, points from league_gameweek_standings where gameweek_id = $1`,
      [ids.gameweek_id],
    );
    expect(standings.rows).toEqual([{ player_id: player1, points: 5 }]);

    // A retroactive backfill straight into Postgres, after scoring already
    // ran — the only way a prediction can be added once its match has kicked
    // off (the API's kickoff lock, lock.ts, forbids it there).
    const player2 = await seedPlayer(client, 'ReadinessPlayer4b');
    await insertPrediction(client, ids, player2, 2, 1); // exact, 5 points
    await client.query(`update predictions set updated_at = $1 where player_id = $2 and game_id = $3`, [
      new Date('2026-08-11T01:00:00Z'),
      player2,
      ids.game_id,
    ]);

    // The next automated tick — no manual admin "rescore" call.
    await repo.runScoringForGameweek(ids.gameweek_id, new Date('2026-08-11T01:05:00Z'));

    standings = await client.query(
      `select player_id, points from league_gameweek_standings where gameweek_id = $1 order by player_id`,
      [ids.gameweek_id],
    );
    expect(standings.rows).toEqual(
      expect.arrayContaining([
        { player_id: player1, points: 5 },
        { player_id: player2, points: 5 },
      ]),
    );
    expect(standings.rows).toHaveLength(2);

    // A later tick with nothing new to backfill must stay a no-op — the
    // idempotency guard the manual "always force" admin rescore never had to
    // respect (repository.ts computeAndPersistScoring's docstring) still
    // holds for the automated path.
    await repo.runScoringForGameweek(ids.gameweek_id, new Date('2026-08-11T01:10:00Z'));
    const completedEvents = await client.query(
      `select count(*)::int as n from telemetry_events where event_type = 'scoring_run_completed' and gameweek_id = $1`,
      [ids.gameweek_id],
    );
    expect(completedEvents.rows[0].n).toBe(2); // once from the initial score, once from the backfill rescore
  });

  it('listGameweeksAwaitingScoring surfaces a gameweek again once backfilled, and stays quiet once nothing has changed', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seedLeague(client, { code: 'sr-5', name: 'Scoring Readiness League 5' });
    await client.query(
      `update games set status = 'finished', home_team_score = 2, away_team_score = 1 where id = $1`,
      [ids.game_id],
    );
    const player1 = await seedPlayer(client, 'ReadinessPlayer5a');
    await insertPrediction(client, ids, player1, 2, 1);
    // Pin this "normal" (pre-kickoff) prediction's updated_at into the
    // fictional past — insertPrediction otherwise leaves it at Postgres's
    // real wall-clock now(), which would already postdate the fixed 2026
    // dates used below as this test's scoring "now" and make it look
    // spuriously stale. Production has no such gap: every timestamp involved
    // comes from the same real clock there.
    await client.query(`update predictions set updated_at = $1 where player_id = $2 and game_id = $3`, [
      new Date('2026-08-10T18:00:00Z'),
      player1,
      ids.game_id,
    ]);
    await client.query(
      `insert into telemetry_events (event_type, league_id, gameweek_id, occurred_at) values ('gameweek_closed', $1, $2, $3)`,
      [ids.league_id, ids.gameweek_id, new Date('2026-08-10T20:00:00Z')],
    );

    expect(await repo.listGameweeksAwaitingScoring()).toContain(ids.gameweek_id);

    await repo.runScoringForGameweek(ids.gameweek_id, new Date('2026-08-11T00:00:00Z'));

    expect(await repo.listGameweeksAwaitingScoring()).not.toContain(ids.gameweek_id);

    const player2 = await seedPlayer(client, 'ReadinessPlayer5b');
    await insertPrediction(client, ids, player2, 2, 1);
    await client.query(`update predictions set updated_at = $1 where player_id = $2 and game_id = $3`, [
      new Date('2026-08-11T01:00:00Z'),
      player2,
      ids.game_id,
    ]);

    expect(await repo.listGameweeksAwaitingScoring()).toContain(ids.gameweek_id);
  });
});
