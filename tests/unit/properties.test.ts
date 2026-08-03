import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { loadLock, loadScoring } from '../support/seams.js';
import type { MatchScoringInput } from '../support/seams.js';

/**
 * Property-based invariants. Each property replaces a family of examples and
 * probes cases nobody enumerated; each still fails for exactly one reason.
 */

const score = fc.integer({ min: 0, max: 9 });
const pair = fc.record({ home: score, away: score });

const matchInput: fc.Arbitrary<MatchScoringInput> = fc.record({
  game_id: fc.uuid(),
  prediction: fc.option(pair, { nil: null }),
  result: fc.option(pair, { nil: null }),
});

describe('scoring invariants', () => {
  it('PROP-01: every match score is one of the four values in the agreed matrix (5/3/2/0)', async () => {
    const scoring = await loadScoring();

    fc.assert(
      fc.property(pair, pair, (prediction, result) => {
        expect([0, 2, 3, 5]).toContain(scoring.scoreMatch(prediction, result));
      }),
    );
  });

  it('PROP-02: predicting the exact final score always scores the maximum 5, for any scoreline', async () => {
    const scoring = await loadScoring();

    fc.assert(
      fc.property(pair, (result) => {
        expect(scoring.scoreMatch({ ...result }, result)).toBe(5);
      }),
    );
  });

  it('PROP-03: points are conserved — a season total equals the sum of its per-gameweek totals', async () => {
    const scoring = await loadScoring();

    fc.assert(
      fc.property(
        fc.array(matchInput, { maxLength: 8 }),
        fc.array(matchInput, { maxLength: 8 }),
        (gameweekA, gameweekB) => {
          const season = scoring.scoreGameweek([...gameweekA, ...gameweekB]).points;
          const perGameweek =
            scoring.scoreGameweek(gameweekA).points + scoring.scoreGameweek(gameweekB).points;
          expect(season).toBe(perGameweek);
        },
      ),
    );
  });
});

describe('lock invariants', () => {
  it('PROP-04: locking is monotonic — once a match is locked it never becomes unlocked at a later instant', async () => {
    const lock = await loadLock();

    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2030-01-01T00:00:00Z') }),
        fc.date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2030-01-01T00:00:00Z') }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (startsAt, now, delayMs) => {
          fc.pre(lock.isLocked(now, startsAt));
          expect(lock.isLocked(new Date(now.getTime() + delayMs), startsAt)).toBe(true);
        },
      ),
    );
  });
});
