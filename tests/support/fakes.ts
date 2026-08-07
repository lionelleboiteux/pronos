/**
 * Test-owned fakes for the *collaborators* of the unit under test.
 *
 * These exist so that, at red, a handler test fails for exactly one reason —
 * "the handler module does not exist" — and never because some other
 * production module it depends on is also missing. Nothing here is a mock of
 * behaviour under test; the DB's own behaviour is exercised against a real
 * Postgres in tests/db, not faked here.
 */

import type {
  AdminOverrideDeps,
  GameRecord,
  GameweekPicks,
  SendReceiptDeps,
  StoredPrediction,
  SubmitDeps,
  TelemetryEvent,
  TelemetrySink,
} from './seams.js';

export function fakeSink(): TelemetrySink {
  const events: TelemetryEvent[] = [];
  return {
    events,
    emit(event: TelemetryEvent) {
      events.push(event);
    },
  };
}

export const eventTypes = (sink: TelemetrySink): string[] =>
  sink.events.map((e) => e.event_type);

export const eventsOfType = (
  events: TelemetryEvent[],
  type: string,
): TelemetryEvent[] => events.filter((e) => e.event_type === type);

/** Counting rate limiter with an explicit, test-supplied threshold. */
export function fakeRateLimiter(max_requests: number) {
  const hits = new Map<string, number>();
  return {
    check(key: string) {
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return { allowed: n <= max_requests, limit: max_requests };
    },
  };
}

export function fakeIdempotencyStore() {
  const keys = new Set<string>();
  return {
    seen: (key: string) => keys.has(key),
    remember: (key: string) => void keys.add(key),
  };
}

export type SubmitDepsOverrides = {
  now?: Date;
  game?: GameRecord | null;
  rateLimit?: number;
  mailerResult?: boolean;
  sink?: TelemetrySink;
};

export type BuiltSubmitDeps = {
  deps: SubmitDeps;
  sink: TelemetrySink;
  sentEmails: Array<{ to: string; receipt: unknown }>;
  upserts: Array<Record<string, unknown>>;
};

export function buildSubmitDeps(
  game: GameRecord | null,
  o: SubmitDepsOverrides = {},
): BuiltSubmitDeps {
  const sink = o.sink ?? fakeSink();
  const sentEmails: Array<{ to: string; receipt: unknown }> = [];
  const upserts: Array<Record<string, unknown>> = [];
  const now = o.now ?? new Date('2026-08-09T09:12:03Z');
  const idem = fakeIdempotencyStore();

  const deps: SubmitDeps = {
    now: () => now,
    repo: {
      getGame: async (game_id: string) =>
        game && game.id === game_id ? game : null,
      upsertPrediction: async (input) => {
        upserts.push({ ...input });
        return { id: 'b1b1b1b1-0000-4a2b-9c3d-cccccccccccc', player_id: 'c2c2c2c2-0000-4a2b-9c3d-dddddddddddd' };
      },
    },
    telemetry: sink,
    mailer: {
      sendReceipt: async (to: string, receipt: unknown) => {
        sentEmails.push({ to, receipt });
        return o.mailerResult ?? true;
      },
    },
    rateLimiter: fakeRateLimiter(o.rateLimit ?? 1_000_000),
    idempotency: idem,
  };

  return { deps, sink, sentEmails, upserts };
}

export type BuiltAdminDeps = {
  deps: AdminOverrideDeps;
  sink: TelemetrySink;
  appliedCalls: number;
};

export function buildAdminOverrideDeps(opts: {
  tokenValid: boolean;
  gameweek?: {
    id: string;
    number: number;
    league_id: string;
    is_current: boolean;
    last_kickoff_at: Date;
  } | null;
  applied?: boolean;
  now?: Date;
}): BuiltAdminDeps {
  const sink = fakeSink();
  const state = { appliedCalls: 0 };
  const store = new Map<string, { status: number; body: Record<string, unknown> }>();
  const now = opts.now ?? new Date('2026-08-11T20:05:00Z');

  const deps: AdminOverrideDeps = {
    now: () => now,
    auth: {
      verifyBearer: async (token: string | null) =>
        opts.tokenValid && token
          ? { valid: true, subject: 'lionel.leboiteux@gmail.com' }
          : { valid: false },
    },
    repo: {
      getGameweek: async () => opts.gameweek ?? null,
      applyAction: async () => {
        state.appliedCalls += 1;
        return {
          applied: opts.applied ?? true,
          current_gameweek_id_before: '9d2f6a10-2222-4a2b-9c3d-555555555555',
          current_gameweek_id_after: '1f2e3d4c-3333-4a2b-9c3d-777788889999',
        };
      },
    },
    telemetry: sink,
    idempotency: {
      lookup: (key, gameweek_id) => store.get(`${key}::${gameweek_id}`) ?? null,
      store: (key, gameweek_id, response) => void store.set(`${key}::${gameweek_id}`, response),
    },
  };

  return {
    deps,
    sink,
    get appliedCalls() {
      return state.appliedCalls;
    },
  } as BuiltAdminDeps;
}

export type BuiltReceiptDeps = {
  deps: SendReceiptDeps;
  sentEmails: Array<{ to: string; subject: string; text: string; html: string }>;
};

export function buildReceiptDeps(
  picks: GameweekPicks | null,
  o: { mailerResult?: boolean } = {},
): BuiltReceiptDeps {
  const sentEmails: Array<{ to: string; subject: string; text: string; html: string }> = [];

  const deps: SendReceiptDeps = {
    repo: {
      getPlayerGameweekPicks: async () => picks,
    },
    mailer: {
      sendReceipt: async (to: string, subject: string, text: string, html: string) => {
        sentEmails.push({ to, subject, text, html });
        return o.mailerResult ?? true;
      },
    },
  };

  return { deps, sentEmails };
}

export function storedPrediction(
  pseudo: string,
  game_id: string,
  home: number,
  away: number,
): StoredPrediction {
  return {
    pseudo,
    game_id,
    predicted_home_score: home,
    predicted_away_score: away,
    submitted_at: new Date('2026-08-09T09:12:03Z'),
  };
}
