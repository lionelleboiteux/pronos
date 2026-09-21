import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepository } from '../../src/db/repository.js';
import { startTestDatabase, type TestDatabase } from '../support/pg.js';

/**
 * repository.recomputeTeamFormSnapshot / getTeamFormByShortName against
 * real Postgres — the write and read sides of GET /v1/teams/form
 * (team_form_snapshot, 20260921134400_create_team_form_snapshot.sql). The
 * whole point of this query is the "last 5 finished games, oldest first,
 * W/D/L from this team's own perspective" logic, plus the upsert-not-
 * duplicate behaviour on a second ingest, neither of which a mock would
 * exercise honestly.
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

type Seeded = {
  league_id: string;
  season_id: string;
  team_a: string; // "Home Town" / short "HTN" / code "HTN"
  team_b: string; // "Away Town" / short "ATN" / code "ATN"
};

async function seed(client: TestDatabase['client'], code: string): Promise<Seeded> {
  const league = await client.query(`insert into leagues (name, code) values ($1, $2) returning id`, [
    `${code} League`,
    code,
  ]);
  const league_id: string = league.rows[0].id;

  const season = await client.query(`insert into seasons (league_id, name) values ($1, $2) returning id`, [
    league_id,
    '2026/2027',
  ]);
  const season_id: string = season.rows[0].id;

  const a = await client.query(
    `insert into teams (league_id, name, code, short_name, display_code) values ($1, $2, $3, $4, $5) returning id`,
    [league_id, `${code} Home Town FC`, `${code}-H`, `${code}Home`, 'HTN'],
  );
  const b = await client.query(
    `insert into teams (league_id, name, code, short_name, display_code) values ($1, $2, $3, $4, $5) returning id`,
    [league_id, `${code} Away Town FC`, `${code}-A`, `${code}Away`, 'ATN'],
  );

  return { league_id, season_id, team_a: a.rows[0].id, team_b: b.rows[0].id };
}

async function insertGame(
  client: TestDatabase['client'],
  ids: Seeded,
  opts: {
    home_team_id: string;
    away_team_id: string;
    starts_at: string;
    status: 'scheduled' | 'finished';
    home_score?: number | null;
    away_score?: number | null;
    external_id: string;
  },
): Promise<string> {
  const gw = await client.query(
    `insert into gameweeks (season_id, league_id, number, starts_at) values ($1, $2, $3, $4) returning id`,
    [ids.season_id, ids.league_id, Math.floor(Math.random() * 100000), opts.starts_at],
  );
  const game = await client.query(
    `insert into games
       (season_id, league_id, gameweek_id, home_team_id, away_team_id, starts_at, status,
        home_team_score, away_team_score, external_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id`,
    [
      ids.season_id,
      ids.league_id,
      gw.rows[0].id,
      opts.home_team_id,
      opts.away_team_id,
      opts.starts_at,
      opts.status,
      opts.home_score ?? null,
      opts.away_score ?? null,
      opts.external_id,
    ],
  );
  return game.rows[0].id;
}

describe('team form snapshot', () => {
  it('getTeamFormByShortName returns null for a league/name combo that does not resolve', async () => {
    const { client } = db();
    const repo = createRepository(client);
    await seed(client, 'tfs-1');

    const result = await repo.getTeamFormByShortName('tfs-1', 'Nobody');

    expect(result).toBeNull();
  });

  it('returns an empty results array for a real team with no finished games yet', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seed(client, 'tfs-2');

    const result = await repo.getTeamFormByShortName('tfs-2', 'tfs-2Home');

    expect(result).toEqual({
      team_name: 'tfs-2 Home Town FC',
      short_name: 'tfs-2Home',
      code: 'HTN',
      results: [],
      updated_at: null,
    });
  });

  it('computes W/D/L from the recomputed team\'s own perspective, oldest first, capped at 5, only finished games', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seed(client, 'tfs-3');

    // 6 finished games (only the most recent 5 should appear) plus one
    // still-scheduled game (must be excluded entirely), deliberately out of
    // chronological order on insert to prove the query sorts, not just
    // trusts insert order. From team_a's perspective, oldest -> newest of
    // the kept 5: 01-02 L, 01-03 W (away), 01-04 D (away), 01-05 W, 01-06 D.
    const games = [
      { starts_at: '2026-01-06T18:00:00Z', home: ids.team_a, away: ids.team_b, hs: 1, as: 1 }, // newest, kept: D
      { starts_at: '2026-01-01T18:00:00Z', home: ids.team_a, away: ids.team_b, hs: 3, as: 0 }, // dropped (oldest of 6): W
      { starts_at: '2026-01-04T18:00:00Z', home: ids.team_b, away: ids.team_a, hs: 2, as: 2 }, // kept: D (away)
      { starts_at: '2026-01-02T18:00:00Z', home: ids.team_a, away: ids.team_b, hs: 0, as: 1 }, // kept, oldest of kept 5: L
      { starts_at: '2026-01-05T18:00:00Z', home: ids.team_a, away: ids.team_b, hs: 2, as: 1 }, // kept: W
      { starts_at: '2026-01-03T18:00:00Z', home: ids.team_b, away: ids.team_a, hs: 0, as: 2 }, // kept: W (away)
    ];
    for (let i = 0; i < games.length; i++) {
      const g = games[i]!;
      await insertGame(client, ids, {
        home_team_id: g.home,
        away_team_id: g.away,
        starts_at: g.starts_at,
        status: 'finished',
        home_score: g.hs,
        away_score: g.as,
        external_id: `tfs-3-finished-${i}`,
      });
    }
    // A 7th, still-scheduled game more recent than all of the above — must
    // never appear in the snapshot.
    await insertGame(client, ids, {
      home_team_id: ids.team_a,
      away_team_id: ids.team_b,
      starts_at: '2026-01-10T18:00:00Z',
      status: 'scheduled',
      external_id: 'tfs-3-scheduled',
    });

    await repo.recomputeTeamFormSnapshot(ids.team_a);
    const result = await repo.getTeamFormByShortName('tfs-3', 'tfs-3Home');

    expect(result?.results.map((r) => r.result)).toEqual(['L', 'W', 'D', 'W', 'D']);
    // Oldest-first: 2026-01-02 is the oldest of the *kept* 5 (2026-01-01 was
    // dropped as the 6th-oldest), newest (2026-01-06) last.
    expect(result?.results.map((r) => r.starts_at.toISOString())).toEqual([
      '2026-01-02T18:00:00.000Z',
      '2026-01-03T18:00:00.000Z',
      '2026-01-04T18:00:00.000Z',
      '2026-01-05T18:00:00.000Z',
      '2026-01-06T18:00:00.000Z',
    ]);
  });

  it("carries the opponent's name/short_name/code and the home/away flag from the recomputed team's perspective", async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seed(client, 'tfs-4');
    await insertGame(client, ids, {
      home_team_id: ids.team_a,
      away_team_id: ids.team_b,
      starts_at: '2026-02-01T18:00:00Z',
      status: 'finished',
      home_score: 2,
      away_score: 0,
      external_id: 'tfs-4-1',
    });

    await repo.recomputeTeamFormSnapshot(ids.team_a);
    const result = await repo.getTeamFormByShortName('tfs-4', 'tfs-4Home');

    expect(result?.results).toEqual([
      {
        game_id: expect.any(String),
        opponent_name: 'tfs-4 Away Town FC',
        opponent_short_name: 'tfs-4Away',
        opponent_code: 'ATN',
        is_home: true,
        team_score: 2,
        opponent_score: 0,
        result: 'W',
        starts_at: new Date('2026-02-01T18:00:00Z'),
      },
    ]);
  });

  it('upserts rather than duplicating on a second recompute (idempotent per team_id)', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const ids = await seed(client, 'tfs-5');
    await insertGame(client, ids, {
      home_team_id: ids.team_a,
      away_team_id: ids.team_b,
      starts_at: '2026-03-01T18:00:00Z',
      status: 'finished',
      home_score: 1,
      away_score: 1,
      external_id: 'tfs-5-1',
    });

    await repo.recomputeTeamFormSnapshot(ids.team_a);
    await repo.recomputeTeamFormSnapshot(ids.team_a);

    const rows = await client.query('select count(*) as n from team_form_snapshot where team_id = $1', [ids.team_a]);
    expect(Number(rows.rows[0].n)).toBe(1);

    const result = await repo.getTeamFormByShortName('tfs-5', 'tfs-5Home');
    expect(result?.results).toHaveLength(1);
    expect(result?.results[0]?.result).toBe('D');
  });
});
