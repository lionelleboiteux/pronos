import { describe, it, expect } from 'vitest';
import { loadGameweekTransition, loadLeagueConfig, loadLock } from '../support/seams.js';
import type { LeagueRow } from '../support/seams.js';
import {
  GW15_LAST_KICKOFF,
  LEAGUE_BUNDESLIGA,
  LEAGUE_LALIGA,
  LEAGUE_LIGUE_1,
  LEAGUE_PREMIER_LEAGUE,
  leagueWithGw15Open,
  t,
} from '../support/fixtures.js';

/**
 * AC-13 — a 4th league is added purely by inserting a row + `leagues.config`
 * (openapi.yaml deliberately has no "create league" endpoint). The test is
 * therefore "the same shared code paths handle a 4th configured league",
 * never "a separate code path exists for it".
 */

const FOUR_LEAGUE_ROWS: LeagueRow[] = [
  { id: LEAGUE_LIGUE_1, code: 'ligue-1', name: 'Ligue 1', config: { fixture_source: { adapter: 'lfp-scrape' }, calendar: { rule: 'official-journee' } } },
  { id: LEAGUE_PREMIER_LEAGUE, code: 'premier-league', name: 'Premier League', config: { fixture_source: { adapter: 'pl-scrape' }, calendar: { rule: 'official-gameweek' } } },
  { id: LEAGUE_BUNDESLIGA, code: 'bundesliga', name: 'Bundesliga', config: { fixture_source: { adapter: 'bl-scrape' }, calendar: { rule: 'official-spieltag' } } },
  // The 4th league: nothing but a row and a config blob.
  { id: LEAGUE_LALIGA, code: 'laliga', name: 'LaLiga', config: { fixture_source: { adapter: 'football-data-org', fallback_adapter: 'football-data-org', params: { competition: 'PD' } }, calendar: { rule: 'official-jornada' } } },
];

describe('league extensibility by configuration alone', () => {
  it('AC-13: a 4th league configured only via leagues.config is loaded by the same loader as the existing three', async () => {
    const cfg = await loadLeagueConfig();

    const loaded = cfg.loadLeagues(FOUR_LEAGUE_ROWS);

    expect(loaded.map((l) => l.code)).toEqual(['ligue-1', 'premier-league', 'bundesliga', 'laliga']);
  });

  it('AC-13: the shared gameweek transition tick advances the 4th league without any league-specific branch', async () => {
    const transition = await loadGameweekTransition();

    const leagues = [
      leagueWithGw15Open(LEAGUE_LIGUE_1, 'ligue-1'),
      leagueWithGw15Open(LEAGUE_LALIGA, 'laliga'),
    ];

    const result = transition.tick(new Date(GW15_LAST_KICKOFF.getTime() + 60_000), leagues);

    expect(result.leagues.map((l) => l.current_gameweek_id)).toEqual([
      'ligue-1-gw16',
      'laliga-gw16',
    ]);
  });

  it('AC-13: the shared submit lock check rejects a late pick in the 4th league exactly as in the existing three', async () => {
    const lock = await loadLock();

    const outcome = lock.evaluateSubmission({
      now: t('2026-08-09T18:55:00Z'),
      game: {
        id: 'laliga-gw15-m1',
        league_id: LEAGUE_LALIGA,
        gameweek_id: 'laliga-gw15',
        starts_at: t('2026-08-09T18:45:00Z'),
      },
      pseudo: 'Lio_92',
      predicted_home_score: 1,
      predicted_away_score: 1,
    });

    expect(outcome).toEqual({ accepted: false, status: 409, error_code: 'MATCH_LOCKED' });
  });
});
