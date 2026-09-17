import { describe, it, expect } from 'vitest';
import { loadEmailMemory } from '../support/seams.js';
import { memoryStorage } from '../support/fixtures.js';

/**
 * Device-side email prefill, mirroring pseudoMemory.test.ts (AC-10) exactly:
 * a pure client-side localStorage convenience with no server-side device
 * token, so it is testable as a pure function over a Storage.
 */

describe('device-side email memory', () => {
  it('returning on the same phone prefills the last-used email and leaves the field editable', async () => {
    const mem = await loadEmailMemory();
    const storage = memoryStorage();

    mem.rememberEmail(storage, 'lio92@example.com');

    expect(mem.buildEmailField(storage)).toEqual({ value: 'lio92@example.com', readOnly: false });
  });

  it('editing the prefilled email before submitting replaces what is remembered for next time', async () => {
    const mem = await loadEmailMemory();
    const storage = memoryStorage();

    mem.rememberEmail(storage, 'old@example.com');
    mem.rememberEmail(storage, 'new@example.com'); // player edited the field, then submitted

    expect(mem.loadRememberedEmail(storage)).toBe('new@example.com');
  });

  it('a first-time device has nothing to prefill and yields an empty, editable field', async () => {
    const mem = await loadEmailMemory();

    expect(mem.buildEmailField(memoryStorage())).toEqual({ value: '', readOnly: false });
  });
});
