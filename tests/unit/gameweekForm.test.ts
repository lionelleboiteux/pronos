import { describe, it, expect } from 'vitest';
import { loadGameweekForm } from '../support/seams.js';
import type { FormGame, ScorePair } from '../support/seams.js';
import { t } from '../support/fixtures.js';

/**
 * Form generation: which fixtures appear, and whether each is selectable.
 * AC-02 (greyed out after kickoff, for every player) and AC-05 (blank
 * gameweek produces no fixture at all).
 */

const KICKOFF = t('2026-08-15T14:00:00Z');
const NOW_AFTER_KICKOFF = t('2026-08-15T14:30:00Z');
const NOW_BEFORE_KICKOFF = t('2026-08-15T13:30:00Z');

const plMatch: FormGame = {
  id: 'pl-gw3-m1',
  home_team_code: 'ARS',
  away_team_code: 'CHE',
  starts_at: KICKOFF,
};

const AC02_CASES: Array<{
  id: string;
  klass: string;
  now: Date;
  myPredictions: Record<string, ScorePair>;
  expected: { is_locked: boolean; selectable: boolean; my_prediction: ScorePair | null };
}> = [
  {
    id: 'AC-02a',
    klass: 'kickoff passed, player never predicted this match',
    now: NOW_AFTER_KICKOFF,
    myPredictions: {},
    expected: { is_locked: true, selectable: false, my_prediction: null },
  },
  {
    id: 'AC-02b',
    klass: 'kickoff passed, player did submit earlier — still greyed out, no re-selection',
    now: NOW_AFTER_KICKOFF,
    myPredictions: { 'pl-gw3-m1': { home: 1, away: 0 } },
    expected: { is_locked: true, selectable: false, my_prediction: { home: 1, away: 0 } },
  },
  {
    id: 'AC-02c',
    klass: 'kickoff not yet passed — selectable',
    now: NOW_BEFORE_KICKOFF,
    myPredictions: {},
    expected: { is_locked: false, selectable: true, my_prediction: null },
  },
];

describe('gameweek form generation', () => {
  it.each(AC02_CASES.map((c) => [`${c.id}: ${c.klass}`, c] as const))(
    '%s',
    async (_title, { now, myPredictions, expected }) => {
      const form = await loadGameweekForm();

      expect(form.buildFormRows(now, [plMatch], myPredictions)).toEqual([
        { game_id: 'pl-gw3-m1', ...expected },
      ]);
    },
  );

  it('AC-05: a blank gameweek — a team with no scheduled match produces no row in the generated form', async () => {
    const form = await loadGameweekForm();

    const gamesInGameweek: FormGame[] = [
      // Only one fixture exists this gameweek; Chelsea (CHE) is blank.
      { id: 'pl-gw3-m2', home_team_code: 'ARS', away_team_code: 'TOT', starts_at: KICKOFF },
    ];

    const rows = form.buildFormRows(NOW_BEFORE_KICKOFF, gamesInGameweek, {});

    expect(rows.map((r) => r.game_id)).toEqual(['pl-gw3-m2']);
  });
});
