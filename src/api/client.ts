/**
 * Typed consumer of contracts/openapi.yaml — the only way either frontend
 * talks to the API.
 *
 * Every non-2xx response is surfaced as a PronosApiError carrying the
 * contract's `error.code`, so callers branch on `MATCH_LOCKED` /
 * `UNAUTHORIZED` rather than on the HTTP status (openapi.yaml §Error
 * envelope).
 */

export type PronosApiError = Error & { code: string; status: number };

export type PronosClient = {
  listLeagues(): Promise<unknown>;
  getCurrentGameweek(args: { leagueId: string; pseudo?: string }): Promise<unknown>;
  submitPrediction(args: Record<string, unknown>): Promise<unknown>;
  getGameweekStandings(args: {
    leagueId: string;
    gameweekId: string;
    page?: number;
    per_page?: number;
  }): Promise<unknown>;
  getOverallStandings(args: {
    leagueId: string;
    seasonId: string;
    page?: number;
    per_page?: number;
  }): Promise<unknown>;
  getCrossLeagueWeeklyStandings(args?: {
    week?: string;
    page?: number;
    per_page?: number;
  }): Promise<unknown>;
  listDuplicateFlags(args?: { status?: string }): Promise<unknown>;
  updateDuplicateFlagStatus(args: {
    flagId: string;
    status: 'reviewed' | 'dismissed';
  }): Promise<unknown>;
  overrideGameweek(args: {
    gameweekId: string;
    idempotencyKey: string;
    action: string;
    duration_minutes_estimate: number;
  }): Promise<unknown>;
};

type ErrorBody = { error?: { code?: string; message?: string } };

function apiError(status: number, body: unknown): PronosApiError {
  const parsed = (body ?? {}) as ErrorBody;
  const error = new Error(parsed.error?.message ?? `Request failed with status ${status}`);
  return Object.assign(error, { code: parsed.error?.code ?? 'INTERNAL_ERROR', status });
}

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) search.set(name, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
};

export function createPronosClient(opts: {
  baseUrl: string;
  headers?: Record<string, string>;
  bearerToken?: string;
}): PronosClient {
  async function call(
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<unknown> {
    const response = await fetch(`${opts.baseUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(opts.bearerToken ? { authorization: `Bearer ${opts.bearerToken}` } : {}),
        ...opts.headers,
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) throw apiError(response.status, payload);
    return payload;
  }

  return {
    listLeagues: () => call('GET', '/v1/leagues'),

    getCurrentGameweek: ({ leagueId, pseudo }) =>
      call('GET', `/v1/leagues/${leagueId}/current${query({ pseudo })}`),

    submitPrediction: (args) => call('POST', '/v1/predictions', { body: args }),

    getGameweekStandings: ({ leagueId, gameweekId, page, per_page }) =>
      call(
        'GET',
        `/v1/leagues/${leagueId}/gameweeks/${gameweekId}/standings${query({ page, per_page })}`,
      ),

    getOverallStandings: ({ leagueId, seasonId, page, per_page }) =>
      call(
        'GET',
        `/v1/leagues/${leagueId}/seasons/${seasonId}/standings/overall${query({ page, per_page })}`,
      ),

    getCrossLeagueWeeklyStandings: (args = {}) =>
      call('GET', `/v1/standings/cross-league${query({ week: args.week, page: args.page, per_page: args.per_page })}`),

    listDuplicateFlags: (args = {}) =>
      call('GET', `/v1/admin/duplicate-flags${query({ status: args.status })}`),

    updateDuplicateFlagStatus: ({ flagId, status }) =>
      call('PATCH', `/v1/admin/duplicate-flags/${flagId}`, { body: { status } }),

    overrideGameweek: ({ gameweekId, idempotencyKey, action, duration_minutes_estimate }) =>
      call('POST', `/v1/admin/gameweeks/${gameweekId}/override`, {
        headers: { 'idempotency-key': idempotencyKey },
        body: { action, duration_minutes_estimate },
      }),
  };
}
