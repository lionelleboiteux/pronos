import { describe, it, expect } from 'vitest';
import { loadGetCurrentGameweek } from '../support/seams.js';
import type { CurrentGameweekDeps } from '../support/seams.js';
import { storedPrediction } from '../support/fakes.js';
import { GAMEWEEK_15, GAME_ASM_LOSC, LEAGUE_LIGUE_1, SEASON_ID, t } from '../support/fixtures.js';

/**
 * NFR-DISCLOSE-01 — 02-architecture.v1.md §7, Information disclosure:
 * "Read endpoints must never return other players' predictions for
 * not-yet-locked matches; only the requester's own (matched by pseudo)".
 * openapi.yaml states the same as a "hard isolation rule".
 *
 * Note (documented in traceability.md): pseudo-spoofing is an *accepted*
 * risk per §7 and ADR-0002 — anyone who types another player's exact pseudo
 * is that player as far as the system is concerned. This test therefore
 * proves the reachable property: a request identifying as B never carries
 * A's pick for an unlocked match.
 */

const NOW = t('2026-08-10T12:00:00Z');
const UNLOCKED_KICKOFF = t('2026-08-10T19:00:00Z');

const team = (code: string) => ({
  id: `team-${code}`,
  name: code,
  code,
  logo_url: null,
});

const deps: CurrentGameweekDeps = {
  now: () => NOW,
  repo: {
    getLeagueCurrentState: async () => ({
      league: { id: LEAGUE_LIGUE_1, code: 'ligue-1', name: 'Ligue 1', logo_url: null },
      season_id: SEASON_ID,
      gameweek: {
        id: GAMEWEEK_15,
        number: 15,
        starts_at: t('2026-08-09T18:45:00Z'),
        ends_at: t('2026-08-11T20:00:00Z'),
        stage_name: 'Journée 15',
      },
      games: [
        {
          id: GAME_ASM_LOSC,
          home_team: team('ASM'),
          away_team: team('LOSC'),
          starts_at: UNLOCKED_KICKOFF,
          status: 'scheduled',
          home_team_score: null,
          away_team_score: null,
        },
      ],
      predictions: [
        storedPrediction('Lio_92', GAME_ASM_LOSC, 4, 0), // another player's pick
        storedPrediction('Jean_M', GAME_ASM_LOSC, 1, 1), // the requester's own
      ],
    }),
  },
};

/** Every predicted score pair reachable anywhere in the response body. */
function predictedPairsIn(body: unknown): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>;
      if (typeof o.predicted_home_score === 'number' && typeof o.predicted_away_score === 'number') {
        found.push([o.predicted_home_score, o.predicted_away_score]);
      }
      Object.values(o).forEach(walk);
    }
  };
  walk(body);
  return found;
}

describe('pre-lock prediction isolation', () => {
  it('NFR-DISCLOSE-01: a direct read as one player never carries another player’s pick for a match that has not locked', async () => {
    const api = await loadGetCurrentGameweek();

    const res = await api.handleGetCurrentGameweek({ league_id: LEAGUE_LIGUE_1, pseudo: 'Jean_M' }, deps);

    // Jean_M's own 1-1 may appear; Lio_92's 4-0 must not, anywhere.
    expect(predictedPairsIn(res.body)).toEqual([[1, 1]]);
  });

  it('NFR-DISCLOSE-02: an anonymous read (no pseudo) carries no player’s pick at all for an unlocked match', async () => {
    const api = await loadGetCurrentGameweek();

    const res = await api.handleGetCurrentGameweek({ league_id: LEAGUE_LIGUE_1 }, deps);

    expect(predictedPairsIn(res.body)).toEqual([]);
  });
});
