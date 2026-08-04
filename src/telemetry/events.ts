/**
 * The 8 required telemetry events (state.json `success.required_events`).
 *
 * An event type outside the agreed 8, or a payload missing a field the success
 * metric needs, is rejected here rather than silently stored — the same rule
 * the `telemetry_events` check constraint enforces in Postgres.
 */

import { randomUUID } from 'node:crypto';

export type TelemetryEvent = {
  id: string;
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

/** Payload fields each event must carry for its metric to be computable. */
const PAYLOAD_FIELDS = {
  match_locked: ['league', 'gameweek', 'match_id', 'kickoff_time'],
  prediction_submitted: [
    'player_pseudo',
    'league',
    'gameweek',
    'match_id',
    'submitted_at',
    'has_email',
  ],
  prediction_rejected_late: [
    'player_pseudo_attempt',
    'league',
    'gameweek',
    'match_id',
    'attempted_at',
  ],
  gameweek_opened: ['league', 'gameweek', 'opened_at'],
  gameweek_closed: ['league', 'gameweek', 'closed_at'],
  scoring_run_completed: ['league', 'gameweek', 'run_at', 'players_scored_count'],
  duplicate_flagged: ['pseudo_a', 'pseudo_b', 'league', 'gameweek', 'similarity_score'],
  admin_manual_intervention: [
    'type',
    'league',
    'gameweek',
    'timestamp',
    'duration_minutes_estimate',
  ],
} as const satisfies Record<string, readonly string[]>;

export type RequiredEventType = keyof typeof PAYLOAD_FIELDS;

export const REQUIRED_EVENT_TYPES: readonly string[] = Object.keys(PAYLOAD_FIELDS);

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Builds one telemetry_events row. Correlation ids are columns, not payload. */
export function buildTelemetryEvent(
  event_type: string,
  fields: Record<string, unknown>,
): TelemetryEvent {
  if (!(event_type in PAYLOAD_FIELDS)) {
    throw new Error(`Unknown telemetry event type: ${event_type}`);
  }
  const payload: Record<string, unknown> = {};
  for (const field of PAYLOAD_FIELDS[event_type as RequiredEventType]) {
    if (!(field in fields)) {
      throw new Error(`Telemetry event ${event_type} is missing required field: ${field}`);
    }
    payload[field] = fields[field];
  }
  return {
    id: randomUUID(),
    event_type,
    league_id: asString(fields.league_id),
    gameweek_id: asString(fields.gameweek_id),
    game_id: asString(fields.game_id),
    occurred_at: asString(fields.occurred_at) ?? new Date().toISOString(),
    payload,
  };
}

/** Collects the events produced while handling one request or tick. */
export function createTelemetrySink(): TelemetrySink {
  const events: TelemetryEvent[] = [];
  return {
    events,
    emit(event: TelemetryEvent) {
      events.push(event);
    },
  };
}
