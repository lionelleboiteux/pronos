import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiClient } from '../support/seams.js';
import { contractOperations, validateAgainstSchema } from '../support/openapi.js';
import { startPrismMock, type PrismMock } from '../support/prism.js';
import {
  GAMEWEEK_15,
  GAME_ASM_LOSC,
  LEAGUE_LIGUE_1,
  SEASON_ID,
} from '../support/fixtures.js';

/**
 * CONSUMER side of the OpenAPI contract. The frontend's client is exercised
 * against a Prism mock generated from contracts/openapi.yaml, and every
 * response it returns is validated against the contract's own schema — so the
 * client cannot pass by agreeing with a hand-written fixture.
 */

const FLAG_ID = 'f1f1f1f1-0000-4a2b-9c3d-111122223333';
const ADMIN_TOKEN = 'test.supabase.jwt';

let prism: PrismMock;

beforeAll(async () => {
  prism = await startPrismMock();
}, 120_000);

afterAll(async () => {
  await prism?.stop();
});

type ConsumerCase = {
  operationId: string;
  responseSchema: string;
  call: (client: any) => Promise<unknown>;
};

const CONSUMER_CASES: ConsumerCase[] = [
  {
    operationId: 'listLeagues',
    responseSchema: 'LeagueListResponse',
    call: (c) => c.listLeagues(),
  },
  {
    operationId: 'getCurrentGameweek',
    responseSchema: 'CurrentGameweekResponse',
    call: (c) => c.getCurrentGameweek({ leagueId: LEAGUE_LIGUE_1, pseudo: 'Lio_92' }),
  },
  {
    operationId: 'submitPrediction',
    responseSchema: 'Prediction',
    call: (c) =>
      c.submitPrediction({
        league_id: LEAGUE_LIGUE_1,
        game_id: GAME_ASM_LOSC,
        pseudo: 'Lio_92',
        email: 'lio92@example.com',
        predicted_home_score: 2,
        predicted_away_score: 1,
      }),
  },
  {
    operationId: 'getGameweekStandings',
    responseSchema: 'LeagueGameweekStandingsResponse',
    call: (c) => c.getGameweekStandings({ leagueId: LEAGUE_LIGUE_1, gameweekId: GAMEWEEK_15 }),
  },
  {
    operationId: 'getOverallStandings',
    responseSchema: 'OverallStandingsResponse',
    call: (c) => c.getOverallStandings({ leagueId: LEAGUE_LIGUE_1, seasonId: SEASON_ID }),
  },
  {
    operationId: 'listDuplicateFlags',
    responseSchema: 'DuplicateFlagListResponse',
    call: (c) => c.listDuplicateFlags({ status: 'pending' }),
  },
  {
    operationId: 'updateDuplicateFlagStatus',
    responseSchema: 'DuplicateFlag',
    call: (c) => c.updateDuplicateFlagStatus({ flagId: FLAG_ID, status: 'dismissed' }),
  },
  {
    operationId: 'overrideGameweek',
    responseSchema: 'GameweekOverrideResponse',
    call: (c) =>
      c.overrideGameweek({
        gameweekId: GAMEWEEK_15,
        idempotencyKey: '6c1a9e2b-4b1a-4e2b-9c3a-abcdefabcdef',
        action: 'close',
        duration_minutes_estimate: 4,
      }),
  },
];

describe('OpenAPI consumer contract (Prism mock)', () => {
  it.each(
    CONSUMER_CASES.map(
      (c) =>
        [
          `CONTRACT-CONSUMER-${c.operationId}: the client parses a contract-valid response into the shape the contract declares`,
          c,
        ] as const,
    ),
  )('%s', async (_title, { responseSchema, call }) => {
    const { createPronosClient } = await loadApiClient();
    const client = createPronosClient({ baseUrl: prism.baseUrl, bearerToken: ADMIN_TOKEN });

    const result = await call(client);

    expect(validateAgainstSchema(responseSchema, result)).toEqual([]);
  });

  it('CONTRACT-CONSUMER-submitPrediction: the client surfaces a 409 as the MATCH_LOCKED code, so the form can show AC-01’s "match already started" message', async () => {
    const { createPronosClient } = await loadApiClient();
    const client = createPronosClient({
      baseUrl: prism.baseUrl,
      headers: { Prefer: 'code=409' },
    });

    const code = await client
      .submitPrediction({
        league_id: LEAGUE_LIGUE_1,
        game_id: GAME_ASM_LOSC,
        pseudo: 'Lio_92',
        predicted_home_score: 2,
        predicted_away_score: 1,
      })
      .then(() => 'no-error-thrown')
      .catch((err: { code?: string }) => err.code);

    expect(code).toBe('MATCH_LOCKED');
  });

  it('CONTRACT-CONSUMER-listDuplicateFlags: the client surfaces a 401 as the UNAUTHORIZED code rather than a generic failure', async () => {
    const { createPronosClient } = await loadApiClient();
    const client = createPronosClient({
      baseUrl: prism.baseUrl,
      headers: { Prefer: 'code=401' },
    });

    const code = await client
      .listDuplicateFlags({ status: 'pending' })
      .then(() => 'no-error-thrown')
      .catch((err: { code?: string }) => err.code);

    expect(code).toBe('UNAUTHORIZED');
  });

  it('CONTRACT-COVERAGE: every operation declared in openapi.yaml has a consumer test in this file', () => {
    const declared = contractOperations().map((o) => o.operationId).sort();

    expect(CONSUMER_CASES.map((c) => c.operationId).sort()).toEqual(declared);
  });
});
