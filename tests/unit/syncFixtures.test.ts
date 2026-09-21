import { describe, it, expect } from 'vitest';
import { handleSyncFixtures, type SyncFixturesDeps, type FixtureInput } from '../../src/api/syncFixtures.ts';

/**
 * POST /v1/ingest/fixtures — this file previously had no coverage at all;
 * added alongside the new recomputeTeamFormSnapshot hook (only that hook's
 * *targeting* — which teams get recomputed, and only once per batch even
 * with duplicate team pairs — is unit-tested here; the W/D/L computation
 * itself is a DB test, tests/db/teamFormSnapshot.test.ts, since it's real
 * SQL, not something a fake repo can honestly exercise).
 */

const HOME = 'a1a1a1a1-0000-4a2b-9c3d-eeeeeeeeee01';
const AWAY = 'a1a1a1a1-0000-4a2b-9c3d-eeeeeeeeee02';
const OTHER_HOME = 'a1a1a1a1-0000-4a2b-9c3d-eeeeeeeeee03';
const OTHER_AWAY = 'a1a1a1a1-0000-4a2b-9c3d-eeeeeeeeee04';
const LEAGUE = 'a1a1a1a1-0000-4a2b-9c3d-eeeeeeeeee00';

function game(overrides: Partial<FixtureInput> = {}): FixtureInput {
  return {
    league_id: LEAGUE,
    gameweek_number: 1,
    home_team_id: HOME,
    away_team_id: AWAY,
    external_id: 'g-1',
    starts_at: '2026-08-22T18:45:00Z',
    status: 'scheduled',
    home_team_score: null,
    away_team_score: null,
    ...overrides,
  };
}

function buildDeps(): { deps: SyncFixturesDeps; recomputed: string[] } {
  const recomputed: string[] = [];
  const deps: SyncFixturesDeps = {
    auth: { verifyBearer: async () => ({ valid: true }) },
    repo: {
      upsertFixture: async () => ({ game_id: 'g', gameweek_id: 'gw' }),
      recomputeTeamFormSnapshot: async (team_id) => {
        recomputed.push(team_id);
      },
    },
  };
  return { deps, recomputed };
}

describe('POST /v1/ingest/fixtures — last-5-form recompute targeting', () => {
  it('does not recompute anything for a batch with only scheduled games', async () => {
    const { deps, recomputed } = buildDeps();

    await handleSyncFixtures(
      { authorization: 'Bearer x', body: { games: [game({ status: 'scheduled' })] } },
      deps,
    );

    expect(recomputed).toEqual([]);
  });

  it('recomputes both the home and away team for a finished game', async () => {
    const { deps, recomputed } = buildDeps();

    await handleSyncFixtures(
      {
        authorization: 'Bearer x',
        body: { games: [game({ status: 'finished', home_team_score: 2, away_team_score: 1 })] },
      },
      deps,
    );

    expect(new Set(recomputed)).toEqual(new Set([HOME, AWAY]));
  });

  it('recomputes each affected team only once, even if it appears in multiple finished games in the batch', async () => {
    const { deps, recomputed } = buildDeps();

    await handleSyncFixtures(
      {
        authorization: 'Bearer x',
        body: {
          games: [
            game({ external_id: 'g-1', status: 'finished', home_team_score: 2, away_team_score: 1 }),
            game({
              external_id: 'g-2',
              status: 'finished',
              home_team_id: HOME,
              away_team_id: OTHER_AWAY,
              home_team_score: 0,
              away_team_score: 0,
            }),
          ],
        },
      },
      deps,
    );

    expect(recomputed.filter((id) => id === HOME)).toHaveLength(1);
    expect(new Set(recomputed)).toEqual(new Set([HOME, AWAY, OTHER_AWAY]));
  });

  it('never recomputes a team whose only games in the batch are still scheduled', async () => {
    const { deps, recomputed } = buildDeps();

    await handleSyncFixtures(
      {
        authorization: 'Bearer x',
        body: {
          games: [
            game({ external_id: 'g-1', status: 'finished', home_team_score: 1, away_team_score: 0 }),
            game({
              external_id: 'g-2',
              status: 'scheduled',
              home_team_id: OTHER_HOME,
              away_team_id: OTHER_AWAY,
            }),
          ],
        },
      },
      deps,
    );

    expect(recomputed).not.toContain(OTHER_HOME);
    expect(recomputed).not.toContain(OTHER_AWAY);
  });
});
