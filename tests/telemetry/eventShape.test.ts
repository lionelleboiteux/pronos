import { describe, it, expect } from 'vitest';
import { loadTelemetry } from '../support/seams.js';

/**
 * The 8 events in spec-header.json / state.json `success.required_events` are
 * as binding as any acceptance criterion: if a field is missing at release,
 * the metric it feeds can never be computed for the period that matters, and
 * the data is gone for good.
 *
 * This file pins the *shape* of each event. Emission behaviour (including the
 * negative paths that supply the denominator) is in emission.test.ts.
 */

type EventSpec = { event_type: string; required: string[]; fields: Record<string, unknown> };

const REQUIRED_EVENTS: EventSpec[] = [
  {
    event_type: 'match_locked',
    required: ['league', 'gameweek', 'match_id', 'kickoff_time'],
    fields: { league: 'ligue-1', gameweek: 15, match_id: 'g1', kickoff_time: '2026-08-09T18:45:00Z' },
  },
  {
    event_type: 'prediction_submitted',
    required: ['player_pseudo', 'league', 'gameweek', 'match_id', 'submitted_at', 'has_email'],
    fields: { player_pseudo: 'Lio_92', league: 'ligue-1', gameweek: 15, match_id: 'g1', submitted_at: '2026-08-09T09:12:03Z', has_email: true },
  },
  {
    event_type: 'prediction_rejected_late',
    required: ['player_pseudo_attempt', 'league', 'gameweek', 'match_id', 'attempted_at'],
    fields: { player_pseudo_attempt: 'Lio_92', league: 'ligue-1', gameweek: 15, match_id: 'g1', attempted_at: '2026-08-09T18:55:00Z' },
  },
  {
    event_type: 'gameweek_opened',
    required: ['league', 'gameweek', 'opened_at'],
    fields: { league: 'ligue-1', gameweek: 16, opened_at: '2026-08-11T20:01:00Z' },
  },
  {
    event_type: 'gameweek_closed',
    required: ['league', 'gameweek', 'closed_at'],
    fields: { league: 'ligue-1', gameweek: 15, closed_at: '2026-08-11T20:01:00Z' },
  },
  {
    event_type: 'scoring_run_completed',
    required: ['league', 'gameweek', 'run_at', 'players_scored_count'],
    fields: { league: 'ligue-1', gameweek: 15, run_at: '2026-08-12T06:00:00Z', players_scored_count: 12 },
  },
  {
    event_type: 'duplicate_flagged',
    required: ['pseudo_a', 'pseudo_b', 'league', 'gameweek', 'similarity_score'],
    fields: { pseudo_a: 'Lio_92', pseudo_b: 'Lio92', league: 'ligue-1', gameweek: 15, similarity_score: 0.94 },
  },
  {
    event_type: 'admin_manual_intervention',
    required: ['type', 'league', 'gameweek', 'timestamp', 'duration_minutes_estimate'],
    fields: { type: 'close', league: 'ligue-1', gameweek: 15, timestamp: '2026-08-11T20:05:00Z', duration_minutes_estimate: 4 },
  },
];

describe('telemetry event shape', () => {
  it.each(
    REQUIRED_EVENTS.map(
      (e) =>
        [
          `TELEMETRY-${e.event_type}: builds a telemetry_events row carrying every field the success metric needs`,
          e,
        ] as const,
    ),
  )('%s', async (_title, { event_type, required, fields }) => {
      const telemetry = await loadTelemetry();

      const event = telemetry.buildTelemetryEvent(event_type, fields);

      expect({
        event_type: event.event_type,
        payload_fields: Object.keys(event.payload).sort(),
    }).toEqual({ event_type, payload_fields: [...required].sort() });
  });

  it('TELEMETRY-REGISTRY: the shipped registry lists exactly the 8 required event types and no others', async () => {
    const telemetry = await loadTelemetry();

    expect([...telemetry.REQUIRED_EVENT_TYPES].sort()).toEqual(
      REQUIRED_EVENTS.map((e) => e.event_type).sort(),
    );
  });

  it('TELEMETRY-prediction_submitted: a payload missing has_email is rejected, because the completion rate cannot be split without it', async () => {
    const telemetry = await loadTelemetry();

    const { has_email, ...withoutHasEmail } = REQUIRED_EVENTS[1].fields as Record<string, unknown>;
    void has_email;

    expect(() => telemetry.buildTelemetryEvent('prediction_submitted', withoutHasEmail)).toThrow();
  });

  it('TELEMETRY-REGISTRY: an event type outside the agreed 8 is rejected rather than silently stored', async () => {
    const telemetry = await loadTelemetry();

    expect(() => telemetry.buildTelemetryEvent('prediction_ignored', {})).toThrow();
  });
});
