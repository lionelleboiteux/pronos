/**
 * POST /v1/predictions. The kickoff lock is decided here and nowhere else:
 * `games.starts_at` at request time is the only authority, so a tampered or
 * stale client cannot buy itself a late submission (AC-01, NFR-LOCK-01).
 *
 * Exactly one of prediction_submitted / prediction_rejected_late is emitted
 * per request — without both directions there is no denominator for "how
 * many submissions arrived too late".
 */

import { z } from 'zod';
import { evaluateSubmission } from '../domain/lock.ts';
import { buildTelemetryEvent, type TelemetrySink } from '../telemetry/events.ts';
import { errorResponse, type ApiResponse } from './errors.ts';

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
  /** Tampered client state — deliberately never read (NFR-LOCK-01). */
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
    remember(key: string, now: Date): void;
  };
};

export type SubmitResponse = ApiResponse;

/**
 * A syntactic check only, deliberately as permissive as RFC 5322 allows in
 * the local part: AC-12 asks for "present and valid", and a stricter pattern
 * would silently drop receipts for addresses the contract accepts.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** openapi.yaml PredictionCreateRequest. */
const SubmitBody = z.object({
  league_id: z.uuid(),
  game_id: z.uuid(),
  pseudo: z.string().min(1).max(60),
  email: z.string().regex(EMAIL).nullish(),
  predicted_home_score: z.int().min(0).max(99),
  predicted_away_score: z.int().min(0).max(99),
});

export async function handleSubmitPrediction(
  req: SubmitRequest,
  deps: SubmitDeps,
): Promise<SubmitResponse> {
  const now = deps.now();

  const { allowed, limit } = deps.rateLimiter.check(req.client_ip, now);
  if (!allowed) {
    return errorResponse(429, 'CONFLICT', 'Too many prediction submissions from this address.', {
      limit_per_minute: limit,
    });
  }

  const parsed = SubmitBody.safeParse(req);
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_FAILED', 'Request failed validation.', {
      fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  const game = await deps.repo.getGame(parsed.data.game_id);
  if (!game) {
    return errorResponse(404, 'NOT_FOUND', 'No game was found matching the given identifier.', {
      game_id: parsed.data.game_id,
    });
  }
  if (game.league_id !== parsed.data.league_id) {
    return errorResponse(400, 'VALIDATION_FAILED', 'league_id does not match the game’s league.', {
      game_id: game.id,
    });
  }

  const outcome = evaluateSubmission({
    now,
    game,
    pseudo: parsed.data.pseudo,
    predicted_home_score: parsed.data.predicted_home_score,
    predicted_away_score: parsed.data.predicted_away_score,
  });

  if (!outcome.accepted) {
    deps.telemetry.emit(
      buildTelemetryEvent('prediction_rejected_late', {
        player_pseudo_attempt: parsed.data.pseudo,
        league: game.league_id,
        gameweek: game.gameweek_number,
        match_id: game.id,
        attempted_at: now.toISOString(),
        league_id: game.league_id,
        gameweek_id: game.gameweek_id,
        game_id: game.id,
        occurred_at: now.toISOString(),
      }),
    );
    return errorResponse(
      outcome.status,
      outcome.error_code,
      `This match started at ${game.starts_at.toISOString()} and can no longer accept predictions.`,
      { game_id: game.id, starts_at: game.starts_at.toISOString() },
    );
  }

  const stored = await deps.repo.upsertPrediction({
    pseudo: parsed.data.pseudo,
    game_id: game.id,
    predicted_home_score: parsed.data.predicted_home_score,
    predicted_away_score: parsed.data.predicted_away_score,
  });

  const email = parsed.data.email ?? null;
  const alreadySent = req.idempotency_key !== undefined && deps.idempotency.seen(req.idempotency_key);
  let email_receipt_queued = false;

  if (email !== null && !alreadySent) {
    email_receipt_queued = await deps.mailer.sendReceipt(email, {
      pseudo: parsed.data.pseudo,
      game_id: game.id,
      predicted_home_score: parsed.data.predicted_home_score,
      predicted_away_score: parsed.data.predicted_away_score,
    });
    if (req.idempotency_key !== undefined) deps.idempotency.remember(req.idempotency_key, now);
  }

  deps.telemetry.emit(
    buildTelemetryEvent('prediction_submitted', {
      player_pseudo: parsed.data.pseudo,
      league: game.league_id,
      gameweek: game.gameweek_number,
      match_id: game.id,
      submitted_at: now.toISOString(),
      has_email: email !== null,
      league_id: game.league_id,
      gameweek_id: game.gameweek_id,
      game_id: game.id,
      occurred_at: now.toISOString(),
    }),
  );

  return {
    status: 200,
    body: {
      id: stored.id,
      player_id: stored.player_id,
      pseudo: parsed.data.pseudo,
      league_id: game.league_id,
      season_id: game.season_id,
      gameweek_id: game.gameweek_id,
      game_id: game.id,
      predicted_home_score: parsed.data.predicted_home_score,
      predicted_away_score: parsed.data.predicted_away_score,
      submitted_at: now.toISOString(),
      email_receipt_queued,
    },
  };
}
