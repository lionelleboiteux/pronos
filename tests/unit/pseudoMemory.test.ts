import { describe, it, expect } from 'vitest';
import { loadPseudoMemory } from '../support/seams.js';
import { memoryStorage } from '../support/fixtures.js';

/**
 * AC-10 — device-side pseudo prefill. Per ADR-0002 this is deliberately a
 * pure client-side localStorage convenience with no server-side device
 * token, so it is testable as a pure function over a Storage.
 */

describe('device-side pseudo memory', () => {
  it('AC-10: returning on the same phone prefills the last-used pseudo and leaves the field editable', async () => {
    const mem = await loadPseudoMemory();
    const storage = memoryStorage();

    mem.rememberPseudo(storage, 'Lio_92');

    expect(mem.buildPseudoField(storage)).toEqual({ value: 'Lio_92', readOnly: false });
  });

  it('AC-10: editing the prefilled pseudo before submitting replaces what is remembered for next time', async () => {
    const mem = await loadPseudoMemory();
    const storage = memoryStorage();

    mem.rememberPseudo(storage, 'Lio_92');
    mem.rememberPseudo(storage, 'Lio92'); // player edited the field, then submitted

    expect(mem.loadRememberedPseudo(storage)).toBe('Lio92');
  });

  it('AC-10: a first-time device has nothing to prefill and yields an empty, editable field', async () => {
    const mem = await loadPseudoMemory();

    expect(mem.buildPseudoField(memoryStorage())).toEqual({ value: '', readOnly: false });
  });
});
