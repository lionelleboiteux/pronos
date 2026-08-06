/**
 * Real Postgres for the tests where Postgres itself is the thing under test
 * (constraints, upsert targets, check constraints, RLS). Nothing here mocks
 * the database — 02-architecture.v1.md §5 records the datastore contract's
 * provider test as "migration tests at red", so these tests apply the
 * PRODUCTION migrations, not the frozen contract DDL.
 *
 * The container is started first, deliberately: that exercises the whole
 * Testcontainers harness on every run, so the only thing that can be missing
 * at the red gate is production code.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');

/** Where production migrations are expected to live (documented in traceability.md). */
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'db', 'migrations');

export const CONTRACT_SCHEMA_PATH = path.join(
  REPO_ROOT,
  'pdlc',
  'jeu-des-pronos',
  'contracts',
  'db-schema.sql',
);

export type TestDatabase = {
  client: pg.Client;
  connectionUri: string;
  stop(): Promise<void>;
};

function readMigrationFiles(): string[] {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(
      `No production migrations found: ${MIGRATIONS_DIR} does not exist. ` +
        `The datastore contract (pdlc/jeu-des-pronos/contracts/db-schema.sql) must be ` +
        `delivered as expand-only migrations in db/migrations/*.sql (ADR-0003).`,
    );
  }
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    throw new Error(
      `No production migrations found: ${MIGRATIONS_DIR} contains no .sql files.`,
    );
  }
  return files;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16-alpine',
  ).start();

  const client = new pg.Client({ connectionString: container.getConnectionUri() });
  await client.connect();

  let migrations: string[];
  try {
    migrations = readMigrationFiles();
  } catch (err) {
    await client.end();
    await container.stop();
    throw err;
  }

  for (const file of migrations) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await client.query(sql);
  }

  return {
    client,
    connectionUri: container.getConnectionUri(),
    async stop() {
      await client.end();
      await container.stop();
    },
  };
}

export type BaselineIds = {
  league_id: string;
  season_id: string;
  gameweek_id: string;
  game_id: string;
  home_team_id: string;
  away_team_id: string;
};

/**
 * Inserts one league/season/teams/gameweek/game using nothing but the shared
 * tables — the same path a 4th league takes (AC-13).
 */
export async function seedLeague(
  client: pg.Client,
  opts: { code: string; name: string; config?: Record<string, unknown>; kickoff?: string },
): Promise<BaselineIds> {
  const config = opts.config ?? {
    fixture_source: { adapter: `${opts.code}-scrape` },
    calendar: { rule: 'official-gameweek' },
  };
  const kickoff = opts.kickoff ?? '2026-08-10T19:00:00Z';

  const league = await client.query(
    `insert into leagues (name, code, config) values ($1, $2, $3::jsonb) returning id`,
    [opts.name, opts.code, JSON.stringify(config)],
  );
  const league_id: string = league.rows[0].id;

  const season = await client.query(
    `insert into seasons (league_id, name) values ($1, $2) returning id`,
    [league_id, '2026/2027'],
  );
  const season_id: string = season.rows[0].id;

  const home = await client.query(
    `insert into teams (league_id, name, code) values ($1, $2, $3) returning id`,
    [league_id, `${opts.code} Home FC`, `${opts.code}-H`],
  );
  const away = await client.query(
    `insert into teams (league_id, name, code) values ($1, $2, $3) returning id`,
    [league_id, `${opts.code} Away FC`, `${opts.code}-A`],
  );

  const gameweek = await client.query(
    `insert into gameweeks (season_id, league_id, number, starts_at) values ($1, $2, $3, $4) returning id`,
    [season_id, league_id, 15, kickoff],
  );
  const gameweek_id: string = gameweek.rows[0].id;

  const game = await client.query(
    `insert into games (season_id, league_id, gameweek_id, home_team_id, away_team_id, starts_at)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [season_id, league_id, gameweek_id, home.rows[0].id, away.rows[0].id, kickoff],
  );

  return {
    league_id,
    season_id,
    gameweek_id,
    game_id: game.rows[0].id,
    home_team_id: home.rows[0].id,
    away_team_id: away.rows[0].id,
  };
}

export async function seedPlayer(
  client: pg.Client,
  pseudo: string,
  email: string | null = null,
): Promise<string> {
  const res = await client.query(
    `insert into players (pseudo, email) values ($1, $2) returning id`,
    [pseudo, email],
  );
  return res.rows[0].id;
}

export async function insertPrediction(
  client: pg.Client,
  ids: BaselineIds,
  player_id: string,
  home: number,
  away: number,
): Promise<void> {
  await client.query(
    `insert into predictions
       (player_id, game_id, gameweek_id, season_id, league_id, pred_home_team_score, pred_away_team_score)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [player_id, ids.game_id, ids.gameweek_id, ids.season_id, ids.league_id, home, away],
  );
}

/** The upsert the submit endpoint relies on (AC-11), keyed on (player_id, game_id). */
export async function upsertPrediction(
  client: pg.Client,
  ids: BaselineIds,
  player_id: string,
  home: number,
  away: number,
): Promise<void> {
  await client.query(
    `insert into predictions
       (player_id, game_id, gameweek_id, season_id, league_id, pred_home_team_score, pred_away_team_score)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (player_id, game_id) do update
       set pred_home_team_score = excluded.pred_home_team_score,
           pred_away_team_score = excluded.pred_away_team_score,
           submitted_at = now(),
           updated_at = now()`,
    [player_id, ids.game_id, ids.gameweek_id, ids.season_id, ids.league_id, home, away],
  );
}

export type PgError = Error & { code?: string };

export async function captureSqlError(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as PgError).code ?? null;
  }
}
