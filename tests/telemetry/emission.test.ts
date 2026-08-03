import { describe, it, expect } from 'vitest';
import {
  loadAdminOverride,
  loadDuplicateDetection,
  loadGameweekTransition,
  loadScoringRun,
  loadSubmitPrediction,
} from '../support/seams.js';
import type { LeagueState, ScoringRunInput, SubmitRequest } from '../support/seams.js';
import {
  buildAdminOverrideDeps,
  buildSubmitDeps,
  eventTypes,
  eventsOfType,
} from '../support/fakes.js';
import {
  GAMEWEEK_15,
  GAME_ASM_LOSC,
  GW15_LAST_KICKOFF,
  LEAGUE_LIGUE_1,
  gameRecord,
  leagueWithGw15Open,
  t,
} from '../support/fixtures.js';

/**
 * Emission behaviour for all 8 required events, positive AND negative path.
 *
 * The negative paths are not optional politeness: an event that only fires on
 * success cannot produce a completion rate, because the denominator is
 * missing. prediction_submitted and prediction_rejected_late in particular
 * must be mutually exclusive on a single request, or "how many submissions
 * arrived too late" is unanswerable after the fact.
 */

const NOW = t('2026-08-09T09:12:03Z');
const OPEN_GAME = gameRecord({ starts_at: t('2026-08-10T19:00:00Z') });
const LOCKED_GAME = gameRecord({ starts_at: t('2026-08-09T08:45:00Z') }); // kicked off 27 min ago

const submitReq = (overrides: Partial<SubmitRequest> = {}): SubmitRequest => ({
  league_id: LEAGUE_LIGUE_1,
  game_id: GAME_ASM_LOSC,
  pseudo: 'Lio_92',
  predicted_home_score: 2,
  predicted_away_score: 1,
  client_ip: '203.0.113.7',
  ...overrides,
});

const AFTER_LAST_KICKOFF = new Date(GW15_LAST_KICKOFF.getTime() + 60_000);
const BEFORE_LAST_KICKOFF = new Date(GW15_LAST_KICKOFF.getTime() - 60_000);

const scoringInput = (overrides: Partial<ScoringRunInput> = {}): ScoringRunInput => ({
  now: t('2026-08-12T06:00:00Z'),
  league_id: LEAGUE_LIGUE_1,
  gameweek_id: GAMEWEEK_15,
  last_kickoff_at: GW15_LAST_KICKOFF,
  already_completed: false,
  players: [
    {
      player_id: 'p1',
      pseudo: 'Lio_92',
      matches: [{ game_id: 'g1', prediction: { home: 2, away: 1 }, result: { home: 2, away: 1 } }],
    },
  ],
  ...overrides,
});

// ---------------------------------------------------------------------------
// prediction_submitted / prediction_rejected_late — the honest denominator
// ---------------------------------------------------------------------------

describe('telemetry: prediction_submitted', () => {
  it('TELEMETRY-prediction_submitted: an accepted submission emits exactly one prediction_submitted event', async () => {
    const api = await loadSubmitPrediction();
    const { deps, sink } = buildSubmitDeps(OPEN_GAME, { now: NOW });

    await api.handleSubmitPrediction(submitReq({ email: 'lio92@example.com' }), deps);

    expect(eventsOfType(sink.events, 'prediction_submitted')).toHaveLength(1);
  });

  it('TELEMETRY-prediction_submitted (negative): a submission rejected as late emits no prediction_submitted event', async () => {
    const api = await loadSubmitPrediction();
    const { deps, sink } = buildSubmitDeps(LOCKED_GAME, { now: NOW });

    await api.handleSubmitPrediction(submitReq(), deps);

    expect(eventsOfType(sink.events, 'prediction_submitted')).toEqual([]);
  });
});

describe('telemetry: prediction_rejected_late', () => {
  it('TELEMETRY-prediction_rejected_late: a 409 MATCH_LOCKED rejection emits exactly one prediction_rejected_late event', async () => {
    const api = await loadSubmitPrediction();
    const { deps, sink } = buildSubmitDeps(LOCKED_GAME, { now: NOW });

    await api.handleSubmitPrediction(submitReq(), deps);

    expect(eventsOfType(sink.events, 'prediction_rejected_late')).toHaveLength(1);
  });

  it('TELEMETRY-prediction_rejected_late (negative): an accepted submission emits no prediction_rejected_late event', async () => {
    const api = await loadSubmitPrediction();
    const { deps, sink } = buildSubmitDeps(OPEN_GAME, { now: NOW });

    await api.handleSubmitPrediction(submitReq(), deps);

    expect(eventsOfType(sink.events, 'prediction_rejected_late')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// match_locked
// ---------------------------------------------------------------------------

describe('telemetry: match_locked', () => {
  it('TELEMETRY-match_locked: the tick emits match_locked for a match whose kickoff has just passed', async () => {
    const transition = await loadGameweekTransition();
    const league = leagueWithGw15Open(LEAGUE_LIGUE_1, 'ligue-1');

    const result = transition.tick(AFTER_LAST_KICKOFF, [league]);

    expect(
      eventsOfType(result.events, 'match_locked').map((e) => e.game_id),
    ).toEqual(['ligue-1-gw15-m2']);
  });

  it('TELEMETRY-match_locked (negative): a match already reported as locked is not re-emitted on a later tick, so lock counts cannot inflate', async () => {
    const transition = await loadGameweekTransition();
    const league: LeagueState = {
      ...leagueWithGw15Open(LEAGUE_LIGUE_1, 'ligue-1'),
    };
    league.gameweeks[0].matches = league.gameweeks[0].matches.map((m) => ({
      ...m,
      lock_event_emitted: true,
    }));

    const result = transition.tick(AFTER_LAST_KICKOFF, [league]);

    expect(eventsOfType(result.events, 'match_locked')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// gameweek_closed / gameweek_opened
// ---------------------------------------------------------------------------

describe('telemetry: gameweek_closed', () => {
  it('TELEMETRY-gameweek_closed: closing a gameweek emits exactly one gameweek_closed event', async () => {
    const transition = await loadGameweekTransition();

    const result = transition.tick(AFTER_LAST_KICKOFF, [leagueWithGw15Open(LEAGUE_LIGUE_1, 'ligue-1')]);

    expect(eventsOfType(result.events, 'gameweek_closed')).toHaveLength(1);
  });

  it('TELEMETRY-gameweek_closed (negative): a tick before the last kickoff emits no gameweek_closed event', async () => {
    const transition = await loadGameweekTransition();

    const result = transition.tick(BEFORE_LAST_KICKOFF, [leagueWithGw15Open(LEAGUE_LIGUE_1, 'ligue-1')]);

    expect(eventsOfType(result.events, 'gameweek_closed')).toEqual([]);
  });
});

describe('telemetry: gameweek_opened', () => {
  it('TELEMETRY-gameweek_opened: the next gameweek becoming open emits exactly one gameweek_opened event', async () => {
    const transition = await loadGameweekTransition();

    const result = transition.tick(AFTER_LAST_KICKOFF, [leagueWithGw15Open(LEAGUE_LIGUE_1, 'ligue-1')]);

    expect(eventsOfType(result.events, 'gameweek_opened')).toHaveLength(1);
  });

  it('TELEMETRY-gameweek_opened (negative): closing the season’s last gameweek emits no gameweek_opened event, since nothing opened', async () => {
    const transition = await loadGameweekTransition();
    const league = leagueWithGw15Open(LEAGUE_LIGUE_1, 'ligue-1');
    league.gameweeks = league.gameweeks.filter((gw) => gw.number === 15); // 15 is the last

    const result = transition.tick(AFTER_LAST_KICKOFF, [league]);

    expect(eventsOfType(result.events, 'gameweek_opened')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scoring_run_completed
// ---------------------------------------------------------------------------

describe('telemetry: scoring_run_completed', () => {
  it('TELEMETRY-scoring_run_completed: a completed scoring run emits one event carrying players_scored_count', async () => {
    const run = await loadScoringRun();

    const out = run.runScoring(scoringInput());

    expect(
      eventsOfType(out.events, 'scoring_run_completed').map((e) => e.payload.players_scored_count),
    ).toEqual([1]);
  });

  it('TELEMETRY-scoring_run_completed (negative): a run skipped as already-completed emits no second event, keeping the dead-man’s-switch honest', async () => {
    const run = await loadScoringRun();

    const out = run.runScoring(scoringInput({ already_completed: true }));

    expect(eventsOfType(out.events, 'scoring_run_completed')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// duplicate_flagged
// ---------------------------------------------------------------------------

describe('telemetry: duplicate_flagged', () => {
  const scanInput = (players: Array<{ player_id: string; pseudo: string }>) => ({
    now: t('2026-08-09T21:00:00Z'),
    league_id: LEAGUE_LIGUE_1,
    league_code: 'ligue-1',
    gameweek_id: GAMEWEEK_15,
    gameweek_number: 15,
    players,
  });

  it('TELEMETRY-duplicate_flagged: the weekly scan emits one duplicate_flagged event per flagged pair, with its similarity score', async () => {
    const dup = await loadDuplicateDetection();

    const out = dup.runWeeklyDuplicateScan(
      scanInput([
        { player_id: 'p-a', pseudo: 'Lio_92' },
        { player_id: 'p-b', pseudo: 'Lio92' },
      ]),
    );

    expect(
      eventsOfType(out.events, 'duplicate_flagged').map((e) => [e.payload.pseudo_a, e.payload.pseudo_b].sort()),
    ).toEqual([['Lio92', 'Lio_92']]);
  });

  it('TELEMETRY-duplicate_flagged (negative): a scan finding no near-duplicate pair emits no event', async () => {
    const dup = await loadDuplicateDetection();

    const out = dup.runWeeklyDuplicateScan(
      scanInput([
        { player_id: 'p-a', pseudo: 'Lio_92' },
        { player_id: 'p-c', pseudo: 'Jean_M' },
      ]),
    );

    expect(eventsOfType(out.events, 'duplicate_flagged')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// admin_manual_intervention
// ---------------------------------------------------------------------------

describe('telemetry: admin_manual_intervention', () => {
  const OPEN_GW = {
    id: GAMEWEEK_15,
    number: 15,
    league_id: LEAGUE_LIGUE_1,
    is_current: true,
    last_kickoff_at: GW15_LAST_KICKOFF,
  };

  const overrideReq = {
    gameweek_id: GAMEWEEK_15,
    authorization: 'Bearer valid.supabase.jwt',
    idempotency_key: '6c1a9e2b-4b1a-4e2b-9c3a-abcdefabcdef',
    body: { action: 'close' as const, duration_minutes_estimate: 4, notes: null },
  };

  it('TELEMETRY-admin_manual_intervention: an applied override emits one event carrying Lio’s duration estimate verbatim', async () => {
    const api = await loadAdminOverride();
    const { deps, sink } = buildAdminOverrideDeps({ tokenValid: true, gameweek: OPEN_GW, applied: true });

    await api.handleGameweekOverride(overrideReq, deps);

    expect(
      eventsOfType(sink.events, 'admin_manual_intervention').map((e) => e.payload.duration_minutes_estimate),
    ).toEqual([4]);
  });

  it('TELEMETRY-admin_manual_intervention (negative): a no-op override emits no event, so a retried no-op cannot inflate weekly admin time', async () => {
    const api = await loadAdminOverride();
    const { deps, sink } = buildAdminOverrideDeps({ tokenValid: true, gameweek: OPEN_GW, applied: false });

    await api.handleGameweekOverride(overrideReq, deps);

    expect(eventTypes(sink)).toEqual([]);
  });
});
