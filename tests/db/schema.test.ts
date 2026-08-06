import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  captureSqlError,
  insertPrediction,
  seedLeague,
  seedPlayer,
  startTestDatabase,
  upsertPrediction,
  type BaselineIds,
  type TestDatabase,
} from '../support/pg.js';

/**
 * Datastore contract, provider side. Runs the PRODUCTION migrations against a
 * real Postgres 16 (Testcontainers) — 02-architecture.v1.md §5 records this
 * as "migration tests at red". Postgres's own behaviour is never mocked.
 *
 * Setup failures are captured rather than thrown from beforeAll, so a missing
 * migration set fails each test individually (visible to the red gate) rather
 * than silently skipping the whole file.
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

/** Throws inside the test body, so the failure is attributed to that test. */
function db(): TestDatabase {
  if (startupError) throw startupError;
  return started as TestDatabase;
}

describe('predictions upsert', () => {
  it('AC-11 / NFR-IDEM-01: two identical submissions before kickoff converge on one prediction row, not two', async () => {
    const { client } = db();
    const ids = await seedLeague(client, { code: 'upsert-l1', name: 'Upsert League' });
    const player = await seedPlayer(client, 'Lio_92_upsert');

    await upsertPrediction(client, ids, player, 2, 1);
    await upsertPrediction(client, ids, player, 2, 1);

    const rows = await client.query(
      'select pred_home_team_score, pred_away_team_score from predictions where player_id = $1 and game_id = $2',
      [player, ids.game_id],
    );

    expect(rows.rows).toEqual([{ pred_home_team_score: 2, pred_away_team_score: 1 }]);
  });

  it('AC-11: resubmitting a different score before kickoff overwrites the previous prediction rather than storing a second entry', async () => {
    const { client } = db();
    const ids = await seedLeague(client, { code: 'overwrite-l1', name: 'Overwrite League' });
    const player = await seedPlayer(client, 'Lio_92_overwrite');

    await upsertPrediction(client, ids, player, 2, 1);
    await upsertPrediction(client, ids, player, 1, 1);

    const rows = await client.query(
      'select pred_home_team_score, pred_away_team_score from predictions where player_id = $1 and game_id = $2',
      [player, ids.game_id],
    );

    expect(rows.rows).toEqual([{ pred_home_team_score: 1, pred_away_team_score: 1 }]);
  });

  it('NFR-IDEM-01: the database itself refuses a second prediction row for the same (player, game), independently of application code', async () => {
    const { client } = db();
    const ids = await seedLeague(client, { code: 'unique-l1', name: 'Unique League' });
    const player = await seedPlayer(client, 'Lio_92_unique');

    await insertPrediction(client, ids, player, 2, 1);
    const sqlstate = await captureSqlError(() => insertPrediction(client, ids, player, 3, 0));

    expect(sqlstate).toBe('23505'); // unique_violation
  });
});

describe('near-duplicate pseudo review queue', () => {
  type DupFixture = { ids: BaselineIds; playerA: string; playerB: string };
  let cached: Promise<DupFixture> | null = null;

  /** Memoised so both tests share one fixture without a failing hook. */
  function dupFixture(): Promise<DupFixture> {
    if (!cached) {
      cached = (async () => {
        const { client } = db();
        const ids = await seedLeague(client, { code: 'dup-l1', name: 'Duplicate League' });
        const playerA = await seedPlayer(client, 'Lio_92_dupq');
        const playerB = await seedPlayer(client, 'Lio92_dupq');
        await insertPrediction(client, ids, playerA, 2, 1);
        await insertPrediction(client, ids, playerB, 0, 0);
        await client.query(
          `insert into duplicate_flags (league_id, gameweek_id, player_a_id, player_b_id, similarity_score)
           values ($1, $2, $3, $4, $5)`,
          [ids.league_id, ids.gameweek_id, playerA, playerB, 0.94],
        );
        return { ids, playerA, playerB };
      })();
    }
    return cached;
  }

  it('AC-09: flagging a near-duplicate pair blocks neither submission and merges neither player — both rows survive intact', async () => {
    const { ids } = await dupFixture();

    const res = await db().client.query(
      `select p.pseudo, pr.pred_home_team_score, pr.pred_away_team_score
         from predictions pr join players p on p.id = pr.player_id
        where pr.gameweek_id = $1
        order by p.pseudo`,
      [ids.gameweek_id],
    );

    expect(res.rows).toEqual([
      { pseudo: 'Lio92_dupq', pred_home_team_score: 0, pred_away_team_score: 0 },
      { pseudo: 'Lio_92_dupq', pred_home_team_score: 2, pred_away_team_score: 1 },
    ]);
  });

  it('AC-09: re-running the weekly scan cannot double-flag the same pair for the same gameweek', async () => {
    const { ids, playerA, playerB } = await dupFixture();
    const { client } = db();

    const sqlstate = await captureSqlError(() =>
      client.query(
        `insert into duplicate_flags (league_id, gameweek_id, player_a_id, player_b_id, similarity_score)
         values ($1, $2, $3, $4, $5)`,
        [ids.league_id, ids.gameweek_id, playerA, playerB, 0.94],
      ),
    );

    expect(sqlstate).toBe('23505'); // unique_violation
  });
});

describe('league extensibility', () => {
  it('AC-13: a 4th league is added by inserting a row plus leagues.config, and then works through the same shared tables with no schema change', async () => {
    const { client } = db();
    const before = await client.query(
      `select count(*)::int as n from information_schema.columns where table_schema = 'public'`,
    );

    const ids = await seedLeague(client, {
      code: 'laliga',
      name: 'LaLiga',
      config: {
        fixture_source: { adapter: 'football-data-org', params: { competition: 'PD' } },
        calendar: { rule: 'official-jornada' },
      },
    });
    const player = await seedPlayer(client, 'Lio_92_laliga');
    await insertPrediction(client, ids, player, 1, 1);

    const after = await client.query(
      `select count(*)::int as n from information_schema.columns where table_schema = 'public'`,
    );

    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('telemetry_events store', () => {
  const REQUIRED_EVENT_TYPES = [
    'match_locked',
    'prediction_submitted',
    'prediction_rejected_late',
    'gameweek_opened',
    'gameweek_closed',
    'scoring_run_completed',
    'duplicate_flagged',
    'admin_manual_intervention',
  ];

  it.each(
    REQUIRED_EVENT_TYPES.map(
      (t) => [`TELEMETRY-${t}: the telemetry_events store accepts this required event type`, t] as const,
    ),
  )('%s', async (_title, event_type) => {
    const res = await db().client.query(
      `insert into telemetry_events (event_type, payload) values ($1, '{}'::jsonb) returning event_type`,
      [event_type],
    );

    expect(res.rows[0].event_type).toBe(event_type);
  });

  it('TELEMETRY-REGISTRY: the store rejects an event type outside the agreed 8, so the metric cannot be polluted', async () => {
    const { client } = db(); // resolved outside captureSqlError so a setup failure is not mistaken for a SQL result
    const sqlstate = await captureSqlError(() =>
      client.query(
        `insert into telemetry_events (event_type, payload) values ('prediction_ignored', '{}'::jsonb)`,
      ),
    );

    expect(sqlstate).toBe('23514'); // check_violation
  });
});

describe('public write protection', () => {
  it('NFR-RLS-01: row level security is enabled on every table an Edge Function writes, so PostgREST cannot bypass the kickoff check', async () => {
    const res = await db().client.query(
      `select c.relname, c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in ('predictions', 'games', 'gameweeks', 'players', 'telemetry_events')
        order by c.relname`,
    );

    expect(res.rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });

  it('NFR-RLS-02: no RLS policy grants the anon or public role INSERT or UPDATE on predictions', async () => {
    const res = await db().client.query(
      `select p.polname
         from pg_policy p join pg_class c on c.oid = p.polrelid
        where c.relname = 'predictions'
          and p.polcmd in ('a', 'w', '*')
          and (p.polroles = '{0}'::oid[]
               or exists (select 1 from pg_roles r where r.oid = any (p.polroles) and r.rolname = 'anon'))`,
    );

    expect(res.rows.map((r) => r.polname)).toEqual([]);
  });
});
