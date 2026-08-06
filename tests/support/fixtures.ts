/**
 * Shared, deterministic fixtures. UUIDs match the examples in
 * pdlc/jeu-des-pronos/contracts/openapi.yaml wherever one exists, so a test
 * failure reads the same way as the contract document.
 */

import type {
  GameRecord,
  GameweekState,
  LeagueState,
  MatchState,
} from './seams.js';

export const LEAGUE_LIGUE_1 = '3f29b6d2-8b1a-4e2b-9c3a-111111111111';
export const LEAGUE_PREMIER_LEAGUE = '51e6a0f0-2c44-4b1d-9a0e-222222222222';
export const LEAGUE_BUNDESLIGA = '7a1d9e60-9d5c-4a2f-9b3e-333333333333';
/** AC-13: a 4th league, added by configuration only. */
export const LEAGUE_LALIGA = '9b3c5d70-4e6f-4a8b-9c0d-444444444444';

export const SEASON_ID = '8a9c6f10-1111-4a2b-9c3d-444444444444';
export const GAMEWEEK_15 = '9d2f6a10-2222-4a2b-9c3d-555555555555';
export const GAMEWEEK_16 = '1f2e3d4c-3333-4a2b-9c3d-777788889999';

export const GAME_OM_PSG = '9c1e4a2e-0000-4a2b-9c3d-666666666666';
export const GAME_ASM_LOSC = '3c3c3c3c-0000-4a2b-9c3d-999999999999';

export const THE_THREE_LEAGUES = [
  { id: LEAGUE_LIGUE_1, code: 'ligue-1', name: 'Ligue 1' },
  { id: LEAGUE_PREMIER_LEAGUE, code: 'premier-league', name: 'Premier League' },
  { id: LEAGUE_BUNDESLIGA, code: 'bundesliga', name: 'Bundesliga' },
] as const;

export const t = (iso: string): Date => new Date(iso);

/** Gameweek 15's last scheduled kickoff, used as the close trigger for AC-06. */
export const GW15_LAST_KICKOFF = t('2026-08-11T20:00:00Z');
export const GW16_FIRST_KICKOFF = t('2026-08-15T18:45:00Z');

export const match = (
  id: string,
  starts_at: Date,
  lock_event_emitted = false,
): MatchState => ({ id, starts_at, lock_event_emitted });

export const gameweek = (
  id: string,
  number: number,
  matches: MatchState[],
): GameweekState => ({ id, number, matches });

/**
 * One league with gameweek 15 open and gameweek 16 waiting behind it.
 * `leagueSuffix` keeps ids unique per league so the AC-07 independence table
 * can run all three side by side.
 */
export function leagueWithGw15Open(
  league_id: string,
  league_code: string,
): LeagueState {
  return {
    league_id,
    league_code,
    current_gameweek_id: `${league_code}-gw15`,
    gameweeks: [
      gameweek(`${league_code}-gw15`, 15, [
        match(`${league_code}-gw15-m1`, t('2026-08-09T18:45:00Z'), true),
        match(`${league_code}-gw15-m2`, GW15_LAST_KICKOFF),
      ]),
      gameweek(`${league_code}-gw16`, 16, [
        match(`${league_code}-gw16-m1`, GW16_FIRST_KICKOFF),
      ]),
    ],
  };
}

export function threeLeaguesWithGw15Open(): LeagueState[] {
  return THE_THREE_LEAGUES.map((l) => leagueWithGw15Open(l.id, l.code));
}

export const gameRecord = (overrides: Partial<GameRecord> = {}): GameRecord => ({
  id: GAME_ASM_LOSC,
  league_id: LEAGUE_LIGUE_1,
  season_id: SEASON_ID,
  gameweek_id: GAMEWEEK_15,
  gameweek_number: 15,
  starts_at: t('2026-08-10T19:00:00Z'),
  ...overrides,
});

/** In-memory Storage stand-in for the AC-10 localStorage seam. */
export function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
  } as Storage;
}
