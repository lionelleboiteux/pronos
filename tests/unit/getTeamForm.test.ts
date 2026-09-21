import { describe, it, expect } from 'vitest';
import { handleGetTeamForm, type TeamFormDeps, type TeamFormRecord } from '../../src/api/getTeamForm.ts';

/**
 * GET /v1/teams/form — the pure handler wiring: 404 when the repo can't
 * resolve league+name, otherwise the record shaped into the wire response
 * (ISO date strings). The repository.ts DB test (tests/db/teamFormSnapshot.test.ts)
 * is what proves the SQL/W-D-L logic itself against real Postgres.
 */

function buildDeps(record: TeamFormRecord | null): TeamFormDeps {
  return {
    repo: {
      getTeamFormByShortName: async () => record,
    },
  };
}

const SAMPLE: TeamFormRecord = {
  team_name: 'Olympique de Marseille',
  short_name: 'Marseille',
  code: 'OM',
  results: [
    {
      game_id: 'a1a1a1a1-0000-4a2b-9c3d-eeeeeeeeeeee',
      opponent_name: 'RC Lens',
      opponent_short_name: 'Lens',
      opponent_code: 'RCL',
      is_home: true,
      team_score: 2,
      opponent_score: 1,
      result: 'W',
      starts_at: new Date('2026-08-22T18:45:00Z'),
    },
  ],
  updated_at: new Date('2026-09-21T09:00:00Z'),
};

describe('GET /v1/teams/form', () => {
  it('returns 404 when the repo finds no matching team', async () => {
    const res = await handleGetTeamForm({ league: 'L1', name: 'Nobody' }, buildDeps(null));

    expect(res.status).toBe(404);
    expect((res.body as any).error.code).toBe('NOT_FOUND');
  });

  it('shapes a found record into the wire response, dates as ISO strings', async () => {
    const res = await handleGetTeamForm({ league: 'L1', name: 'Marseille' }, buildDeps(SAMPLE));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      team_name: 'Olympique de Marseille',
      short_name: 'Marseille',
      code: 'OM',
      results: [
        {
          game_id: 'a1a1a1a1-0000-4a2b-9c3d-eeeeeeeeeeee',
          opponent_name: 'RC Lens',
          opponent_short_name: 'Lens',
          opponent_code: 'RCL',
          is_home: true,
          team_score: 2,
          opponent_score: 1,
          result: 'W',
          starts_at: '2026-08-22T18:45:00.000Z',
        },
      ],
      updated_at: '2026-09-21T09:00:00.000Z',
    });
  });

  it('renders null updated_at as null, not a crash, for a team with no finished games yet', async () => {
    const res = await handleGetTeamForm(
      { league: 'L1', name: 'Marseille' },
      buildDeps({ ...SAMPLE, results: [], updated_at: null }),
    );

    expect(res.status).toBe(200);
    expect((res.body as any).results).toEqual([]);
    expect((res.body as any).updated_at).toBeNull();
  });
});
