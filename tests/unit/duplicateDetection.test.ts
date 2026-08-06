import { describe, it, expect } from 'vitest';
import { loadDuplicateDetection } from '../support/seams.js';
import type { PseudoRef } from '../support/seams.js';

/**
 * Duplicate-pseudo similarity scan — 02-architecture.v1.md §1, seam:
 * "pure function over a list of pseudos for a gameweek, no DB needed".
 *
 * The "neither submission is blocked or auto-merged" half of AC-09 is proved
 * against a real Postgres in tests/db/schema.test.ts, because it is a
 * statement about persisted rows, not about the string-distance function.
 */

const LIO_UNDERSCORE: PseudoRef = { player_id: 'p-a', pseudo: 'Lio_92' };
const LIO_NO_UNDERSCORE: PseudoRef = { player_id: 'p-b', pseudo: 'Lio92' };
const UNRELATED: PseudoRef = { player_id: 'p-c', pseudo: 'Jean_M' };

describe('near-duplicate pseudo detection', () => {
  it('AC-09: "Lio_92" and "Lio92" submitted in the same gameweek are surfaced together as a likely match', async () => {
    const dup = await loadDuplicateDetection();

    const flags = dup.findNearDuplicatePseudos([LIO_UNDERSCORE, LIO_NO_UNDERSCORE, UNRELATED]);

    expect(
      flags.map((f) => [f.player_a.pseudo, f.player_b.pseudo].sort()),
    ).toEqual([['Lio92', 'Lio_92']]);
  });

  it('AC-09: the similarity score for "Lio_92"/"Lio92" is at or above the flagging threshold', async () => {
    const dup = await loadDuplicateDetection();

    const [flag] = dup.findNearDuplicatePseudos([LIO_UNDERSCORE, LIO_NO_UNDERSCORE]);

    expect(flag.similarity_score).toBeGreaterThanOrEqual(dup.DEFAULT_SIMILARITY_THRESHOLD);
  });

  it('AC-09: clearly distinct pseudos are not flagged, so the weekly review queue stays reviewable', async () => {
    const dup = await loadDuplicateDetection();

    expect(dup.findNearDuplicatePseudos([LIO_UNDERSCORE, UNRELATED])).toEqual([]);
  });
});
