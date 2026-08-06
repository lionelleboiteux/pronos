import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import { loadApiServer } from '../support/seams.js';
import { seedLeague, seedPlayer, startTestDatabase, type BaselineIds, type TestDatabase } from '../support/pg.js';

/**
 * The only end-to-end journeys in this suite. Everything else is proved at the
 * lowest layer that can prove it; these two exist because their failure in
 * production would be embarrassing and invisible until the classement is
 * already wrong:
 *
 *   E2E-01  submit -> lock -> score -> classement, for one gameweek.
 *   E2E-02  a late submission is rejected all the way through, and the
 *           telemetry pair that makes "how many were late" answerable is
 *           actually written to telemetry_events.
 *
 * Both run against a real Postgres and the real HTTP API.
 */

const ADMIN_TOKEN = 'red-gate-admin-token';
const KICKOFF = '2026-08-10T19:00:00Z';

type E2EContext = {
  db: TestDatabase;
  server: { url: string; stop(): Promise<void> };
  ids: BaselineIds;
};

let started: E2EContext | null = null;
let startupError: Error | null = null;

/** Throws inside the test body so the failure is attributed to that test. */
function ctx(): E2EContext {
  if (startupError) throw startupError;
  return started as E2EContext;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  let db: TestDatabase | null = null;
  try {
    const { startServer } = await loadApiServer();
    db = await startTestDatabase();
    const ids = await seedLeague(db.client, { code: 'e2e-l1', name: 'E2E League', kickoff: KICKOFF });
    await seedPlayer(db.client, 'Lio_92_e2e');
    const server = await startServer({
      port: await freePort(),
      databaseUrl: db.connectionUri,
      adminToken: ADMIN_TOKEN,
    });
    started = { db, server, ids };
  } catch (err) {
    startupError = err as Error;
    await db?.stop().catch(() => undefined);
  }
}, 240_000);

afterAll(async () => {
  await started?.server.stop().catch(() => undefined);
  await started?.db.stop().catch(() => undefined);
});

const post = (baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('end-to-end gameweek journey', () => {
  it('E2E-01: a submitted prediction is scored after the gameweek closes and appears in that gameweek’s classement', async () => {
    const { db, server, ids } = ctx();

    await post(server.url, '/v1/predictions', {
      league_id: ids.league_id,
      game_id: ids.game_id,
      pseudo: 'Lio_92_e2e',
      predicted_home_score: 2,
      predicted_away_score: 1,
    });

    // The match kicks off and finishes with the exact predicted score.
    await db.client.query(
      `update games set starts_at = now() - interval '3 hours', status = 'finished',
              home_team_score = 2, away_team_score = 1
        where id = $1`,
      [ids.game_id],
    );

    await post(
      server.url,
      `/v1/admin/gameweeks/${ids.gameweek_id}/override`,
      { action: 'rescore', duration_minutes_estimate: 0 },
      { authorization: `Bearer ${ADMIN_TOKEN}`, 'idempotency-key': 'e2e-01-rescore' },
    );

    const standings = await fetch(
      `${server.url}/v1/leagues/${ids.league_id}/gameweeks/${ids.gameweek_id}/standings`,
    ).then((r) => r.json() as Promise<{ data: Array<{ pseudo: string; points: number }> }>);

    expect(standings.data.map((row) => [row.pseudo, row.points])).toEqual([['Lio_92_e2e', 5]]);
  });

  it('E2E-02: a prediction submitted after kickoff is rejected with MATCH_LOCKED and recorded as rejected-late, never as submitted', async () => {
    const { db, server, ids } = ctx();

    await db.client.query(`update games set starts_at = now() - interval '10 minutes' where id = $1`, [
      ids.game_id,
    ]);

    const res = await post(server.url, '/v1/predictions', {
      league_id: ids.league_id,
      game_id: ids.game_id,
      pseudo: 'Lio_92_late',
      predicted_home_score: 0,
      predicted_away_score: 3,
    });

    const events = await db.client.query(
      `select event_type from telemetry_events
        where game_id = $1 and payload->>'player_pseudo_attempt' = 'Lio_92_late'
           or (game_id = $1 and payload->>'player_pseudo' = 'Lio_92_late')`,
      [ids.game_id],
    );

    expect({
      status: res.status,
      code: ((await res.json()) as { error?: { code?: string } }).error?.code,
      events: events.rows.map((r) => r.event_type),
    }).toEqual({
      status: 409,
      code: 'MATCH_LOCKED',
      events: ['prediction_rejected_late'],
    });
  });
});
