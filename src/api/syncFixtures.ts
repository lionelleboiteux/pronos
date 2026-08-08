/**
 * POST /v1/ingest/fixtures — machine-to-machine endpoint for the scheduled
 * fixture/results sync (GitHub Actions cron + the Python scraper in
 * scripts/ingestion). Not part of the player-facing or admin-review surface:
 * it exists purely to keep `games` current (kickoff-time changes, final
 * scores) as the season progresses.
 *
 * Auth is a separate bearer secret from ADMIN_TOKEN (ctx.ingestToken),
 * deliberately: this credential lives in a GitHub Actions secret rather than
 * an operator's hands, so a leak there shouldn't grant gameweek-override or
 * duplicate-flag-review capability — least privilege for a CI credential.
 *
 * Team/gameweek resolution happens on the caller's side (the Python script
 * reads teams/leagues first and sends resolved UUIDs) rather than here, so
 * this handler stays a dumb, idempotent upsert with no fuzzy-matching logic
 * of its own.
 */

import { z } from 'zod';
import { errorResponse, type ApiResponse } from './errors.ts';

export type SyncFixturesRequest = {
  authorization: string | null;
  body: unknown;
};

export type FixtureInput = {
  league_id: string;
  gameweek_number: number;
  home_team_id: string;
  away_team_id: string;
  external_id: string;
  starts_at: string;
  status: 'scheduled' | 'finished';
  home_team_score: number | null;
  away_team_score: number | null;
};

export type SyncFixturesDeps = {
  auth: { verifyBearer(token: string | null): Promise<{ valid: boolean }> };
  repo: {
    upsertFixture(input: FixtureInput): Promise<{ game_id: string; gameweek_id: string }>;
  };
};

const bearerToken = (header: string | null): string | null => {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  return match ? (match[1] as string) : null;
};

const FixtureSchema = z.object({
  league_id: z.uuid(),
  gameweek_number: z.number().int().min(1),
  home_team_id: z.uuid(),
  away_team_id: z.uuid(),
  external_id: z.string().min(1),
  starts_at: z.iso.datetime({ offset: true }),
  status: z.enum(['scheduled', 'finished']),
  home_team_score: z.number().int().min(0).nullable(),
  away_team_score: z.number().int().min(0).nullable(),
});

const Body = z.object({ games: z.array(FixtureSchema).min(1).max(500) });

export async function handleSyncFixtures(
  req: SyncFixturesRequest,
  deps: SyncFixturesDeps,
): Promise<ApiResponse> {
  const session = await deps.auth.verifyBearer(bearerToken(req.authorization));
  if (!session.valid) {
    return errorResponse(401, 'UNAUTHORIZED', 'A valid ingest bearer token is required for this endpoint.');
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_FAILED', 'Request failed validation.', {
      fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  const results: Array<{ game_id: string; gameweek_id: string; external_id: string }> = [];
  for (const game of parsed.data.games) {
    const outcome = await deps.repo.upsertFixture(game);
    results.push({ ...outcome, external_id: game.external_id });
  }

  return { status: 200, body: { games_processed: results.length, games: results } };
}
