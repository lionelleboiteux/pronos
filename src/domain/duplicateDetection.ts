/**
 * Near-duplicate pseudo detection (AC-09) — a pure function over the pseudos
 * of one gameweek. It only *surfaces* pairs for Lio's weekly review queue:
 * nothing here blocks a submission or merges two players, and no endpoint
 * anywhere does either.
 */

import { buildTelemetryEvent, type TelemetryEvent } from '../telemetry/events.ts';

export type PseudoRef = { player_id: string; pseudo: string };

export type DuplicateCandidate = {
  player_a: PseudoRef;
  player_b: PseudoRef;
  similarity_score: number;
};

export type DuplicateScanInput = {
  now: Date;
  league_id: string;
  league_code: string;
  gameweek_id: string;
  gameweek_number: number;
  players: PseudoRef[];
};

/** "Lio_92" vs "Lio92" scores 0.83; "Lio_92" vs "Jean_M" scores well under. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.8;

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(substitution, (previous[j] as number) + 1, (current[j - 1] as number) + 1));
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** 1.0 for identical strings, 0.0 for strings sharing nothing. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

export function findNearDuplicatePseudos(
  pseudos: PseudoRef[],
  opts: { threshold?: number } = {},
): DuplicateCandidate[] {
  const threshold = opts.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const candidates: DuplicateCandidate[] = [];

  for (let i = 0; i < pseudos.length; i += 1) {
    for (let j = i + 1; j < pseudos.length; j += 1) {
      const player_a = pseudos[i] as PseudoRef;
      const player_b = pseudos[j] as PseudoRef;
      const similarity_score = similarity(player_a.pseudo, player_b.pseudo);
      if (similarity_score >= threshold) candidates.push({ player_a, player_b, similarity_score });
    }
  }

  return candidates;
}

/** The weekly review-queue job: flags plus their duplicate_flagged events. */
export function runWeeklyDuplicateScan(input: DuplicateScanInput): {
  flags: DuplicateCandidate[];
  events: TelemetryEvent[];
} {
  const flags = findNearDuplicatePseudos(input.players);
  const occurred_at = input.now.toISOString();

  return {
    flags,
    events: flags.map((flag) =>
      buildTelemetryEvent('duplicate_flagged', {
        pseudo_a: flag.player_a.pseudo,
        pseudo_b: flag.player_b.pseudo,
        league: input.league_code,
        gameweek: input.gameweek_number,
        similarity_score: flag.similarity_score,
        league_id: input.league_id,
        gameweek_id: input.gameweek_id,
        occurred_at,
      }),
    ),
  };
}
