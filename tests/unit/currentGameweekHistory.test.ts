import { describe, expect, it, vi } from 'vitest';
import { handleGetCurrentGameweek } from '../../src/api/getCurrentGameweek.ts';

const LEAGUE = '27f27a15-02a9-448a-98d5-80998e2fa52e';

describe('GET /v1/leagues/{id}/current ?gameweek=N (read-only history)', () => {
  it('asks the repository for the requested earlier gameweek and returns only the caller\'s own picks', async () => {
    const getLeagueCurrentState = vi.fn(async () => ({
      league: { id: LEAGUE, code: 'L1', name: 'Ligue 1', logo_url: null },
      season_id: 's1',
      gameweek: { id: 'gw3', number: 3, starts_at: new Date('2026-09-01T18:00:00Z'), ends_at: null, stage_name: null },
      games: [
        {
          id: 'g1',
          home_team: { id: 'h', name: 'H', code: 'H', logo_url: null },
          away_team: { id: 'a', name: 'A', code: 'A', logo_url: null },
          starts_at: new Date('2026-09-01T18:00:00Z'),
          status: 'finished',
          home_team_score: 2,
          away_team_score: 1,
        },
      ],
      predictions: [
        { pseudo: 'me', game_id: 'g1', predicted_home_score: 2, predicted_away_score: 1, submitted_at: new Date() },
        { pseudo: 'other', game_id: 'g1', predicted_home_score: 0, predicted_away_score: 0, submitted_at: new Date() },
      ],
    }));

    const res = await handleGetCurrentGameweek(
      { league_id: LEAGUE, pseudo: 'me', gameweek_number: 3 },
      { now: () => new Date('2026-10-01T00:00:00Z'), repo: { getLeagueCurrentState } },
    );

    expect(getLeagueCurrentState).toHaveBeenCalledWith(LEAGUE, 3);
    const body = res.body as { games: { is_locked: boolean; my_prediction: { predicted_home_score: number } | null }[] };
    expect(body.games[0].is_locked).toBe(true);
    expect(body.games[0].my_prediction?.predicted_home_score).toBe(2);
    expect(JSON.stringify(body)).not.toContain('other');
  });
});
