import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepository } from '../../src/db/repository.js';
import { startTestDatabase, type TestDatabase } from '../support/pg.js';

/**
 * repository.insertPageView / getWeeklyPageViews against real Postgres —
 * the write and read sides of the first-party page-view counter shared by
 * every fantasy-coach.fr sibling site (page_views,
 * 20260916121420_create_page_views_table.sql). The whole point of this
 * query is the date_trunc('week', ...) bucketing and the group-by-project
 * aggregation, neither of which a mock would exercise honestly.
 */

let started: TestDatabase | null = null;
let startupError: Error | null = null;

beforeAll(async () => {
  try {
    started = await startTestDatabase();
  } catch (err) {
    startupError = err as Error;
  }
}, 240_000);

afterAll(async () => {
  await started?.stop().catch(() => undefined);
});

function db(): TestDatabase {
  if (startupError) throw startupError;
  return started as TestDatabase;
}

describe('page view counts', () => {
  it('records a view with no `view` value for a single-page sibling (DNP/compos/groupes)', async () => {
    const { client } = db();
    const repo = createRepository(client);

    await repo.insertPageView({ project: 'dnp-write-test' });

    const rows = await client.query('select project, view from page_views where project = $1', ['dnp-write-test']);
    expect(rows.rows).toEqual([{ project: 'dnp-write-test', view: null }]);
  });

  it('records the optional `view` for pronos, the one multi-view sibling', async () => {
    const { client } = db();
    const repo = createRepository(client);

    await repo.insertPageView({ project: 'pronos-write-test', view: 'standings' });

    const rows = await client.query('select project, view from page_views where project = $1', ['pronos-write-test']);
    expect(rows.rows).toEqual([{ project: 'pronos-write-test', view: 'standings' }]);
  });

  it('buckets views by ISO week per project, across a real week boundary', async () => {
    const { client } = db();
    const repo = createRepository(client);
    const project = 'weekly-bucket-test';

    // 2026-08-10 is a Monday (start of an ISO week); one hit just before it
    // (still the prior week) and two just after (the new week).
    await client.query(`insert into page_views (project, created_at) values ($1, $2)`, [
      project,
      '2026-08-09T23:00:00Z',
    ]);
    await client.query(`insert into page_views (project, created_at) values ($1, $2)`, [
      project,
      '2026-08-10T08:00:00Z',
    ]);
    await client.query(`insert into page_views (project, created_at) values ($1, $2)`, [
      project,
      '2026-08-12T19:00:00Z',
    ]);

    const weekly = await repo.getWeeklyPageViews();
    const forProject = weekly.filter((w) => w.project === project);

    expect(forProject).toEqual([
      { project, week_start: '2026-08-03', views: 1 },
      { project, week_start: '2026-08-10', views: 2 },
    ]);
  });

  it('keeps different projects distinguishable within the same week', async () => {
    const { client } = db();
    const repo = createRepository(client);

    await client.query(`insert into page_views (project, created_at) values ($1, $2)`, [
      'project-a-distinguish-test',
      '2026-09-01T10:00:00Z',
    ]);
    await client.query(`insert into page_views (project, created_at) values ($1, $2)`, [
      'project-b-distinguish-test',
      '2026-09-01T10:00:00Z',
    ]);

    const weekly = await repo.getWeeklyPageViews();

    expect(weekly).toContainEqual({ project: 'project-a-distinguish-test', week_start: '2026-08-31', views: 1 });
    expect(weekly).toContainEqual({ project: 'project-b-distinguish-test', week_start: '2026-08-31', views: 1 });
  });
});
