/**
 * SEAMS — the single place that names every production module this test suite
 * expects to exist, at the paths implied by 02-architecture.v1.md §1
 * "Testability assessment".
 *
 * NONE of these modules exist yet. That is the point of the red gate: each
 * loader below is called lazily from inside a test body, so a missing module
 * fails exactly one test with exactly one reason
 * ("Failed to load url ../../src/domain/scoring ... Does the file exist?")
 * rather than collapsing a whole file at collection time.
 *
 * Rules for this file:
 *   - every import specifier is a static string literal (so Vite resolves it
 *     lazily and reports the real path in the failure message);
 *   - every import happens inside a function, never at module top level;
 *   - the interfaces below are the test suite's *expectation* of each seam's
 *     signature. They are test-side type declarations, not implementations.
 *
 * Module map (documented in pdlc/jeu-des-pronos/traceability.md):
 *   src/domain/scoring.ts             pure scoring calculator (5/3/2/0)
 *   src/domain/lock.ts                lock/reject check, injectable `now`
 *   src/domain/gameweekForm.ts        form row generation (lock state + own pick)
 *   src/domain/gameweekTransition.ts  transition tick, injectable `now`
 *   src/domain/scoringRun.ts          morning-after scoring run, injectable `now`
 *   src/domain/duplicateDetection.ts  pseudo similarity scan
 *   src/domain/leagueConfig.ts        leagues.config loading (AC-13)
 *   src/telemetry/events.ts           telemetry event construction + sink
 *   src/api/submitPrediction.ts       POST /v1/predictions handler
 *   src/api/getCurrentGameweek.ts     GET /v1/leagues/{id}/current handler
 *   src/api/adminOverride.ts          POST /v1/admin/gameweeks/{id}/override handler
 *   src/api/rateLimit.ts              submit-endpoint rate limiter
 *   src/api/client.ts                 typed consumer client (contract consumer side)
 *   src/api/server.ts                 provider entrypoint (contract provider side)
 *   src/client/pseudoMemory.ts        device-side pseudo prefill (AC-10)
 *   db/migrations/*.sql               production migrations (DB provider side)
 */

/* eslint-disable @typescript-eslint/ban-ts-comment */

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

export type ScorePair = { home: number; away: number };

export type TelemetryEvent = {
  event_type: string;
  league_id: string | null;
  gameweek_id: string | null;
  game_id: string | null;
  occurred_at: string;
  payload: Record<string, unknown>;
};

export type TelemetrySink = {
  emit(event: TelemetryEvent): void;
  events: TelemetryEvent[];
};

// ---------------------------------------------------------------------------
// src/domain/scoring.ts
// ---------------------------------------------------------------------------

export type MatchScoringInput = {
  game_id: string;
  /** null when the player submitted no prediction for this match (AC-03). */
  prediction: ScorePair | null;
  /** null when no final result has been reported yet. */
  result: ScorePair | null;
};

export type GameweekTotal = {
  points: number;
  /** AC-03: matches with no prediction are excluded from this count. */
  scored_match_count: number;
  correct_results_count: number;
  exact_scores_count: number;
};

export interface ScoringModule {
  /** 5 exact score, 3 correct outcome + goal difference, 2 correct outcome, 0 otherwise. */
  scoreMatch(prediction: ScorePair | null, result: ScorePair | null): number;
  /** Sums every match in one gameweek into a single total (AC-04). */
  scoreGameweek(matches: MatchScoringInput[]): GameweekTotal;
}

export async function loadScoring(): Promise<ScoringModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/domain/scoring')) as unknown as ScoringModule;
}

// ---------------------------------------------------------------------------
// src/domain/lock.ts
// ---------------------------------------------------------------------------

export type GameRef = {
  id: string;
  league_id: string;
  gameweek_id: string;
  starts_at: Date;
};

export type SubmissionAttempt = {
  now: Date;
  game: GameRef;
  pseudo: string;
  predicted_home_score: number;
  predicted_away_score: number;
  /**
   * What the client believes about lock state. NFR-LOCK-01: the server must
   * ignore this field entirely and decide from game.starts_at alone.
   */
  client_claims_unlocked?: boolean;
};

export type SubmissionOutcome =
  | { accepted: true }
  | { accepted: false; status: 409; error_code: 'MATCH_LOCKED' };

export interface LockModule {
  /** True when starts_at <= now. Kickoff instant itself counts as locked. */
  isLocked(now: Date, startsAt: Date): boolean;
  evaluateSubmission(attempt: SubmissionAttempt): SubmissionOutcome;
}

export async function loadLock(): Promise<LockModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/domain/lock')) as unknown as LockModule;
}

// ---------------------------------------------------------------------------
// src/domain/gameweekForm.ts
// ---------------------------------------------------------------------------

export type FormGame = {
  id: string;
  home_team_code: string;
  away_team_code: string;
  starts_at: Date;
};

export type FormRow = {
  game_id: string;
  is_locked: boolean;
  /** false whenever is_locked is true — AC-02's grey-out, for every player. */
  selectable: boolean;
  my_prediction: ScorePair | null;
};

export interface GameweekFormModule {
  buildFormRows(
    now: Date,
    games: FormGame[],
    myPredictions: Record<string, ScorePair>,
  ): FormRow[];
}

export async function loadGameweekForm(): Promise<GameweekFormModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/domain/gameweekForm')) as unknown as GameweekFormModule;
}

// ---------------------------------------------------------------------------
// src/domain/gameweekTransition.ts
// ---------------------------------------------------------------------------

export type MatchState = {
  id: string;
  starts_at: Date;
  /** Guards against re-emitting match_locked on every tick. */
  lock_event_emitted: boolean;
};

export type GameweekState = {
  id: string;
  number: number;
  matches: MatchState[];
};

export type LeagueState = {
  league_id: string;
  league_code: string;
  current_gameweek_id: string | null;
  gameweeks: GameweekState[];
};

export type TickResult = {
  leagues: LeagueState[];
  events: TelemetryEvent[];
};

export interface GameweekTransitionModule {
  /** pg_cron-driven tick with `now` injected, never read from the wall clock. */
  tick(now: Date, leagues: LeagueState[]): TickResult;
}

export async function loadGameweekTransition(): Promise<GameweekTransitionModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/domain/gameweekTransition')) as unknown as GameweekTransitionModule;
}

// ---------------------------------------------------------------------------
// src/domain/scoringRun.ts
// ---------------------------------------------------------------------------

export type ScoringRunPlayer = {
  player_id: string;
  pseudo: string;
  matches: MatchScoringInput[];
};

export type ScoringRunInput = {
  now: Date;
  league_id: string;
  gameweek_id: string;
  /** Kickoff of the gameweek's last scheduled match. */
  last_kickoff_at: Date;
  /** True when a scoring_run_completed event already exists for this gameweek. */
  already_completed: boolean;
  players: ScoringRunPlayer[];
};

export type StandingsRow = {
  player_id: string;
  pseudo: string;
  points: number;
  rank: number;
  predictions_count: number;
  correct_results_count: number;
  exact_scores_count: number;
};

export type ScoringRunOutput = {
  ran: boolean;
  skipped_reason?: 'already_completed' | 'gameweek_not_finished';
  standings: StandingsRow[];
  players_scored_count: number;
  events: TelemetryEvent[];
};

export interface ScoringRunModule {
  runScoring(input: ScoringRunInput): ScoringRunOutput;
}

export async function loadScoringRun(): Promise<ScoringRunModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/domain/scoringRun')) as unknown as ScoringRunModule;
}

// ---------------------------------------------------------------------------
// src/domain/duplicateDetection.ts
// ---------------------------------------------------------------------------

export type PseudoRef = { player_id: string; pseudo: string };

export type DuplicateCandidate = {
  player_a: PseudoRef;
  player_b: PseudoRef;
  similarity_score: number;
};

export type DuplicateScanInput = {
  now: Date;
  league_id: string;
  league_code: string;
  gameweek_id: string;
  gameweek_number: number;
  players: PseudoRef[];
};

export interface DuplicateDetectionModule {
  DEFAULT_SIMILARITY_THRESHOLD: number;
  findNearDuplicatePseudos(
    pseudos: PseudoRef[],
    opts?: { threshold?: number },
  ): DuplicateCandidate[];
  /** The weekly review-queue job: flags plus their duplicate_flagged events. */
  runWeeklyDuplicateScan(input: DuplicateScanInput): {
    flags: DuplicateCandidate[];
    events: TelemetryEvent[];
  };
}

export async function loadDuplicateDetection(): Promise<DuplicateDetectionModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/domain/duplicateDetection')) as unknown as DuplicateDetectionModule;
}

// ---------------------------------------------------------------------------
// src/domain/leagueConfig.ts
// ---------------------------------------------------------------------------

export type LeagueRow = {
  id: string;
  code: string;
  name: string;
  config: unknown;
};

export type ConfiguredLeague = {
  id: string;
  code: string;
  name: string;
  fixture_source: { adapter: string; fallback_adapter?: string; params?: Record<string, unknown> };
  calendar: { rule: string; params?: Record<string, unknown> };
};

export interface LeagueConfigModule {
  /** Loads every league row purely from `leagues.config` — no per-league code. */
  loadLeagues(rows: LeagueRow[]): ConfiguredLeague[];
}

export async function loadLeagueConfig(): Promise<LeagueConfigModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/domain/leagueConfig')) as unknown as LeagueConfigModule;
}

// ---------------------------------------------------------------------------
// src/telemetry/events.ts
// ---------------------------------------------------------------------------

export interface TelemetryModule {
  REQUIRED_EVENT_TYPES: readonly string[];
  /**
   * Builds one telemetry_events row. Must reject an unknown event_type and
   * must reject a payload missing any field the spec header requires.
   */
  buildTelemetryEvent(
    event_type: string,
    fields: Record<string, unknown>,
  ): TelemetryEvent;
  createTelemetrySink(): TelemetrySink;
}

export async function loadTelemetry(): Promise<TelemetryModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/telemetry/events')) as unknown as TelemetryModule;
}

// ---------------------------------------------------------------------------
// src/api/submitPrediction.ts
// ---------------------------------------------------------------------------

export type GameRecord = {
  id: string;
  league_id: string;
  season_id: string;
  gameweek_id: string;
  gameweek_number: number;
  starts_at: Date;
};

export type SubmitRequest = {
  league_id: string;
  game_id: string;
  pseudo: string;
  email?: string | null;
  predicted_home_score: number;
  predicted_away_score: number;
  idempotency_key?: string;
  client_ip: string;
  /** Tampered client state — must never influence the decision (NFR-LOCK-01). */
  client_claims_unlocked?: boolean;
};

export type SubmitDeps = {
  now(): Date;
  repo: {
    getGame(game_id: string): Promise<GameRecord | null>;
    upsertPrediction(input: {
      pseudo: string;
      game_id: string;
      predicted_home_score: number;
      predicted_away_score: number;
    }): Promise<{ id: string; player_id: string }>;
  };
  telemetry: TelemetrySink;
  mailer: { sendReceipt(to: string, receipt: unknown): Promise<boolean> };
  rateLimiter: { check(key: string, now: Date): { allowed: boolean; limit: number } };
  idempotency: {
    seen(key: string): boolean;
    remember(key: string): void;
  };
};

export type SubmitResponse = {
  status: number;
  body: Record<string, unknown>;
};

export interface SubmitPredictionModule {
  handleSubmitPrediction(req: SubmitRequest, deps: SubmitDeps): Promise<SubmitResponse>;
}

export async function loadSubmitPrediction(): Promise<SubmitPredictionModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/api/submitPrediction')) as unknown as SubmitPredictionModule;
}

// ---------------------------------------------------------------------------
// src/api/getCurrentGameweek.ts
// ---------------------------------------------------------------------------

export type StoredPrediction = {
  pseudo: string;
  game_id: string;
  predicted_home_score: number;
  predicted_away_score: number;
  submitted_at: Date;
};

export type CurrentGameweekDeps = {
  now(): Date;
  repo: {
    getLeagueCurrentState(league_id: string): Promise<{
      league: { id: string; code: string; name: string; logo_url: string | null };
      season_id: string | null;
      gameweek: { id: string; number: number; starts_at: Date; ends_at: Date | null; stage_name: string | null } | null;
      games: Array<{
        id: string;
        home_team: { id: string; name: string; code: string; logo_url: string | null };
        away_team: { id: string; name: string; code: string; logo_url: string | null };
        starts_at: Date;
        status: string;
        home_team_score: number | null;
        away_team_score: number | null;
      }>;
      /** Every prediction stored for this gameweek, across all players. */
      predictions: StoredPrediction[];
    } | null>;
  };
};

export interface GetCurrentGameweekModule {
  handleGetCurrentGameweek(
    req: { league_id: string; pseudo?: string },
    deps: CurrentGameweekDeps,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

export async function loadGetCurrentGameweek(): Promise<GetCurrentGameweekModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/api/getCurrentGameweek')) as unknown as GetCurrentGameweekModule;
}

// ---------------------------------------------------------------------------
// src/api/adminOverride.ts
// ---------------------------------------------------------------------------

export type AdminOverrideRequest = {
  gameweek_id: string;
  authorization: string | null;
  idempotency_key: string | null;
  body: {
    action: 'open' | 'close' | 'rescore';
    duration_minutes_estimate: number;
    notes?: string | null;
  };
};

export type AdminOverrideDeps = {
  now(): Date;
  auth: { verifyBearer(token: string | null): Promise<{ valid: boolean; subject?: string }> };
  repo: {
    getGameweek(gameweek_id: string): Promise<{
      id: string;
      number: number;
      league_id: string;
      is_current: boolean;
      last_kickoff_at: Date;
    } | null>;
    applyAction(action: 'open' | 'close' | 'rescore', gameweek_id: string): Promise<{
      applied: boolean;
      current_gameweek_id_before: string | null;
      current_gameweek_id_after: string | null;
    }>;
  };
  telemetry: TelemetrySink;
  idempotency: {
    lookup(key: string, gameweek_id: string): { status: number; body: Record<string, unknown> } | null;
    store(key: string, gameweek_id: string, response: { status: number; body: Record<string, unknown> }): void;
  };
};

export interface AdminOverrideModule {
  handleGameweekOverride(
    req: AdminOverrideRequest,
    deps: AdminOverrideDeps,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

export async function loadAdminOverride(): Promise<AdminOverrideModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/api/adminOverride')) as unknown as AdminOverrideModule;
}

// ---------------------------------------------------------------------------
// src/api/rateLimit.ts
// ---------------------------------------------------------------------------

export interface RateLimitModule {
  /**
   * NFR-RATE-01. The architecture doc leaves the threshold unspecified
   * ("e.g. N/minute/IP"); SUBMIT_RATE_LIMIT_PER_MINUTE is the assumed
   * placeholder — see traceability.md, needs product-owner confirmation.
   */
  SUBMIT_RATE_LIMIT_PER_MINUTE: number;
  createRateLimiter(opts: { max_requests: number; window_ms: number }): {
    check(key: string, now: Date): { allowed: boolean; limit: number };
  };
}

export async function loadRateLimit(): Promise<RateLimitModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/api/rateLimit')) as unknown as RateLimitModule;
}

// ---------------------------------------------------------------------------
// src/client/pseudoMemory.ts
// ---------------------------------------------------------------------------

export type PseudoField = { value: string; readOnly: boolean };

export interface PseudoMemoryModule {
  rememberPseudo(storage: Storage, pseudo: string): void;
  loadRememberedPseudo(storage: Storage): string | null;
  /** AC-10: prefilled from the device, and still editable. */
  buildPseudoField(storage: Storage): PseudoField;
}

export async function loadPseudoMemory(): Promise<PseudoMemoryModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/client/pseudoMemory')) as unknown as PseudoMemoryModule;
}

// ---------------------------------------------------------------------------
// src/api/client.ts  (consumer side of the OpenAPI contract)
// ---------------------------------------------------------------------------

export type PronosClient = {
  listLeagues(): Promise<unknown>;
  getCurrentGameweek(args: { leagueId: string; pseudo?: string }): Promise<unknown>;
  submitPrediction(args: Record<string, unknown>): Promise<unknown>;
  getGameweekStandings(args: { leagueId: string; gameweekId: string; page?: number; per_page?: number }): Promise<unknown>;
  getOverallStandings(args: { leagueId: string; seasonId: string; page?: number; per_page?: number }): Promise<unknown>;
  listDuplicateFlags(args?: { status?: string }): Promise<unknown>;
  updateDuplicateFlagStatus(args: { flagId: string; status: 'reviewed' | 'dismissed' }): Promise<unknown>;
  overrideGameweek(args: { gameweekId: string; idempotencyKey: string; action: string; duration_minutes_estimate: number }): Promise<unknown>;
};

export type PronosApiError = Error & { code: string; status: number };

export interface ApiClientModule {
  createPronosClient(opts: {
    baseUrl: string;
    headers?: Record<string, string>;
    bearerToken?: string;
  }): PronosClient;
}

export async function loadApiClient(): Promise<ApiClientModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/api/client')) as unknown as ApiClientModule;
}

// ---------------------------------------------------------------------------
// src/api/server.ts  (provider side of the OpenAPI contract)
// ---------------------------------------------------------------------------

export interface ApiServerModule {
  /** Boots the Edge Function router over a real HTTP port for provider tests. */
  startServer(opts: { port: number; databaseUrl: string; adminToken: string }): Promise<{
    url: string;
    stop(): Promise<void>;
  }>;
}

export async function loadApiServer(): Promise<ApiServerModule> {
  // @ts-ignore -- production module does not exist yet (red gate)
  return (await import('../../src/api/server')) as unknown as ApiServerModule;
}
