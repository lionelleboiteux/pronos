import { describe, it, expect } from 'vitest';
import { loadScoringRun } from '../support/seams.js';
import type { ScoringRunInput } from '../support/seams.js';
import { GAMEWEEK_15, GW15_LAST_KICKOFF, LEAGUE_PREMIER_LEAGUE, t } from '../support/fixtures.js';

/**
 * Morning-after scoring run (AC-08, AC-14). `now` is injected, matching the
 * pg_cron tick seam in 02-architecture.v1.md §1.
 */

const MORNING_AFTER = t('2026-08-12T06:00:00Z');

const baseInput = (overrides: Partial<ScoringRunInput> = {}): ScoringRunInput => ({
  now: MORNING_AFTER,
  league_id: LEAGUE_PREMIER_LEAGUE,
  gameweek_id: GAMEWEEK_15,
  last_kickoff_at: GW15_LAST_KICKOFF,
  already_completed: false,
  players: [
    {
      player_id: 'c2c2c2c2-0000-4a2b-9c3d-dddddddddddd',
      pseudo: 'Lio_92',
      matches: [
        { game_id: 'g1', prediction: { home: 2, away: 1 }, result: { home: 2, away: 1 } }, // 5
        { game_id: 'g2', prediction: { home: 1, away: 0 }, result: { home: 2, away: 1 } }, // 3
      ],
    },
  ],
  ...overrides,
});

describe('morning-after scoring run', () => {
  it('AC-08: the scheduled run updates the classement for the finished gameweek', async () => {
    const run = await loadScoringRun();

    const out = run.runScoring(baseInput());

    expect(out.standings).toEqual([
      {
        player_id: 'c2c2c2c2-0000-4a2b-9c3d-dddddddddddd',
        pseudo: 'Lio_92',
        points: 8,
        rank: 1,
        predictions_count: 2,
        correct_results_count: 2,
        exact_scores_count: 1,
      },
    ]);
  });

  it('AC-08: a second run for the same gameweek is a no-op, so the classement is updated exactly once', async () => {
    const run = await loadScoringRun();

    const second = run.runScoring(baseInput({ already_completed: true }));

    expect({ ran: second.ran, skipped_reason: second.skipped_reason }).toEqual({
      ran: false,
      skipped_reason: 'already_completed',
    });
  });

  it('AC-14: a gameweek that closed with zero submissions produces a classement without error and shows no change', async () => {
    const run = await loadScoringRun();

    const out = run.runScoring(baseInput({ players: [] }));

    expect({ ran: out.ran, standings: out.standings, players_scored_count: out.players_scored_count }).toEqual({
      ran: true,
      standings: [],
      players_scored_count: 0,
    });
  });
});
