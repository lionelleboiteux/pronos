/**
 * POST /v1/admin/gameweeks/{gameweekId}/override — the escape hatch for when
 * the automated pipeline fails.
 *
 * Two things are load-bearing here beyond the action itself: the bearer check
 * (NFR-AUTH-01), and the Idempotency-Key replay (NFR-IDEM-02). The latter
 * guards the project's primary success metric — a retried no-op that emitted a
 * second admin_manual_intervention would inflate "weekly manual admin time",
 * the exact number this endpoint exists to keep honest.
 */

import { z } from 'zod';
import { isLocked } from '../domain/lock.ts';
import { buildTelemetryEvent, type TelemetrySink } from '../telemetry/events.ts';
import { errorResponse, type ApiResponse } from './errors.ts';

export type OverrideAction = 'open' | 'close' | 'rescore';

export type AdminOverrideRequest = {
  gameweek_id: string;
  authorization: string | null;
  idempotency_key: string | null;
  /** Raw request body — validated against GameweekOverrideRequest below. */
  body: unknown;
};

export type GameweekRecord = {
  id: string;
  number: number;
  league_id: string;
  is_current: boolean;
  last_kickoff_at: Date;
};

export type AdminOverrideDeps = {
  now(): Date;
  auth: { verifyBearer(token: string | null): Promise<{ valid: boolean; subject?: string }> };
  repo: {
    getGameweek(gameweek_id: string): Promise<GameweekRecord | null>;
    applyAction(
      action: OverrideAction,
      gameweek_id: string,
    ): Promise<{
      applied: boolean;
      current_gameweek_id_before: string | null;
      current_gameweek_id_after: string | null;
    }>;
  };
  telemetry: TelemetrySink;
  idempotency: {
    lookup(key: string, gameweek_id: string): ApiResponse | null;
    store(key: string, gameweek_id: string, response: ApiResponse): void;
  };
};

/** openapi.yaml GameweekOverrideRequest. */
const OverrideBody = z.object({
  action: z.enum(['open', 'close', 'rescore']),
  duration_minutes_estimate: z.number().min(0),
  notes: z.string().nullish(),
});

const bearerToken = (header: string | null): string | null => {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  return match ? (match[1] as string) : null;
};

/**
 * `close` needs the gameweek to still be its league's open one; `rescore`
 * needs its last match to have kicked off. Anything else is a 409.
 */
function conflictReason(action: OverrideAction, gameweek: GameweekRecord, now: Date): string | null {
  if (action === 'close' && !gameweek.is_current) {
    return `Gameweek ${gameweek.number} is not its league's open gameweek; it cannot be closed.`;
  }
  if (action === 'rescore' && !isLocked(now, gameweek.last_kickoff_at)) {
    return `Gameweek ${gameweek.number} has not closed yet; it cannot be rescored.`;
  }
  return null;
}

export async function handleGameweekOverride(
  req: AdminOverrideRequest,
  deps: AdminOverrideDeps,
): Promise<ApiResponse> {
  const session = await deps.auth.verifyBearer(bearerToken(req.authorization));
  if (!session.valid) {
    return errorResponse(
      401,
      'UNAUTHORIZED',
      'A valid Supabase Auth bearer token is required for this endpoint.',
    );
  }

  if (!req.idempotency_key) {
    return errorResponse(400, 'VALIDATION_FAILED', 'The Idempotency-Key header is required.');
  }
  const replay = deps.idempotency.lookup(req.idempotency_key, req.gameweek_id);
  if (replay) return replay;

  const parsed = OverrideBody.safeParse(req.body);
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_FAILED', 'Request failed validation.', {
      fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  const gameweek = await deps.repo.getGameweek(req.gameweek_id);
  if (!gameweek) {
    return errorResponse(404, 'NOT_FOUND', 'No gameweek was found matching the given identifier.', {
      gameweek_id: req.gameweek_id,
    });
  }

  const now = deps.now();
  const conflict = conflictReason(parsed.data.action, gameweek, now);
  if (conflict) {
    return errorResponse(409, 'CONFLICT', conflict, {
      gameweek_id: gameweek.id,
      action: parsed.data.action,
    });
  }

  const outcome = await deps.repo.applyAction(parsed.data.action, gameweek.id);

  let telemetry_event_id: string | null = null;
  if (outcome.applied) {
    const event = buildTelemetryEvent('admin_manual_intervention', {
      type: parsed.data.action,
      league: gameweek.league_id,
      gameweek: gameweek.number,
      timestamp: now.toISOString(),
      duration_minutes_estimate: parsed.data.duration_minutes_estimate,
      league_id: gameweek.league_id,
      gameweek_id: gameweek.id,
      occurred_at: now.toISOString(),
    });
    deps.telemetry.emit(event);
    telemetry_event_id = event.id;
  }

  const response: ApiResponse = {
    status: 200,
    body: {
      gameweek_id: gameweek.id,
      league_id: gameweek.league_id,
      action: parsed.data.action,
      applied: outcome.applied,
      current_gameweek_id_before: outcome.current_gameweek_id_before,
      current_gameweek_id_after: outcome.current_gameweek_id_after,
      telemetry_event_id,
      applied_at: now.toISOString(),
    },
  };

  deps.idempotency.store(req.idempotency_key, req.gameweek_id, response);
  return response;
}
