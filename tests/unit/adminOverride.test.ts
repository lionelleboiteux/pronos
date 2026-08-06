import { describe, it, expect } from 'vitest';
import { loadAdminOverride } from '../support/seams.js';
import type { AdminOverrideRequest } from '../support/seams.js';
import { buildAdminOverrideDeps, eventsOfType } from '../support/fakes.js';
import { GAMEWEEK_15, GW15_LAST_KICKOFF, LEAGUE_LIGUE_1, t } from '../support/fixtures.js';

/**
 * POST /v1/admin/gameweeks/{gameweekId}/override.
 * NFR-AUTH-01 (elevation of privilege, §7) and NFR-IDEM-02 (the required
 * Idempotency-Key, openapi.yaml) — the latter guards the project's primary
 * success metric from being inflated by client retries.
 */

const OPEN_GW = {
  id: GAMEWEEK_15,
  number: 15,
  league_id: LEAGUE_LIGUE_1,
  is_current: true,
  last_kickoff_at: GW15_LAST_KICKOFF,
};

const request = (overrides: Partial<AdminOverrideRequest> = {}): AdminOverrideRequest => ({
  gameweek_id: GAMEWEEK_15,
  authorization: 'Bearer valid.supabase.jwt',
  idempotency_key: '6c1a9e2b-4b1a-4e2b-9c3a-abcdefabcdef',
  body: { action: 'close', duration_minutes_estimate: 4, notes: null },
  ...overrides,
});

describe('admin gameweek override', () => {
  it('NFR-AUTH-01: a request with no bearer token is rejected 401 UNAUTHORIZED', async () => {
    const api = await loadAdminOverride();
    const { deps } = buildAdminOverrideDeps({ tokenValid: false, gameweek: OPEN_GW });

    const res = await api.handleGameweekOverride(request({ authorization: null }), deps);

    expect({ status: res.status, code: (res.body as any)?.error?.code }).toEqual({
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('NFR-AUTH-01: a request with a valid bearer token performs the override normally', async () => {
    const api = await loadAdminOverride();
    const { deps } = buildAdminOverrideDeps({ tokenValid: true, gameweek: OPEN_GW, now: t('2026-08-11T20:05:00Z') });

    const res = await api.handleGameweekOverride(request(), deps);

    expect({ status: res.status, applied: res.body.applied }).toEqual({ status: 200, applied: true });
  });

  it('NFR-IDEM-02: replaying the same Idempotency-Key for the same gameweek does not insert a second admin_manual_intervention row', async () => {
    const api = await loadAdminOverride();
    const { deps, sink } = buildAdminOverrideDeps({ tokenValid: true, gameweek: OPEN_GW });

    await api.handleGameweekOverride(request(), deps);
    await api.handleGameweekOverride(request(), deps);

    expect(eventsOfType(sink.events, 'admin_manual_intervention')).toHaveLength(1);
  });

  it('NFR-IDEM-02: a replay returns the original stored response unchanged rather than re-running the action', async () => {
    const api = await loadAdminOverride();
    const { deps } = buildAdminOverrideDeps({ tokenValid: true, gameweek: OPEN_GW });

    const first = await api.handleGameweekOverride(request(), deps);
    const second = await api.handleGameweekOverride(request(), deps);

    expect(second).toEqual(first);
  });
});
