import { describe, it, expect } from 'vitest';
import { handleRecordPageView, type RecordPageViewDeps, type RecordPageViewRequest } from '../../src/api/recordPageView.ts';

/**
 * POST /v1/page-view — a first-party view counter shared by pronos, DNP,
 * compos, and groupes via fc-shared's pageview.js, tagged with `project`
 * so hits from every sibling site stay distinguishable in one table.
 */

function buildDeps(): { deps: RecordPageViewDeps; inserts: { project: string; view?: string }[] } {
  const inserts: { project: string; view?: string }[] = [];
  const deps: RecordPageViewDeps = {
    repo: {
      insertPageView: async (input) => {
        inserts.push(input);
      },
    },
  };
  return { deps, inserts };
}

const req = (overrides: Partial<RecordPageViewRequest> = {}): RecordPageViewRequest => ({
  body: { project: 'dnp' },
  ...overrides,
});

describe('page-view project tagging', () => {
  it('records the project sent by the client', async () => {
    const { deps, inserts } = buildDeps();

    const res = await handleRecordPageView(req({ body: { project: 'compos' } }), deps);

    expect(res.status).toBe(200);
    expect(inserts).toEqual([{ project: 'compos', view: undefined }]);
  });

  it('records an optional view (pronos only has more than one)', async () => {
    const { deps, inserts } = buildDeps();

    await handleRecordPageView(req({ body: { project: 'pronos', view: 'standings' } }), deps);

    expect(inserts[0]).toEqual({ project: 'pronos', view: 'standings' });
  });

  it('treats a blank view string the same as omitted', async () => {
    const { deps, inserts } = buildDeps();

    await handleRecordPageView(req({ body: { project: 'pronos', view: '  ' } }), deps);

    expect(inserts[0]?.view).toBeUndefined();
  });

  it('rejects a request with no project at all — 400, not a silently-dropped hit', async () => {
    const { deps, inserts } = buildDeps();

    const res = await handleRecordPageView(req({ body: {} }), deps);

    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  it('rejects an empty-string project the same way', async () => {
    const { deps } = buildDeps();

    const res = await handleRecordPageView(req({ body: { project: '' } }), deps);

    expect(res.status).toBe(400);
  });
});
