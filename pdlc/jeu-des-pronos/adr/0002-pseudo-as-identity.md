# ADR-0002: Pseudo string is the player identity; no server-side device tracking

- **Status:** accepted
- **Date:** 2026-08-03
- **Unit:** jeu-des-pronos
- **Deciders:** Lionel Le Boiteux, Claude (Sonnet 5)

## Context

The spec explicitly rules out accounts, passwords, or mandatory personal data
(assumptions, §9) — a player is identified only by a free-text pseudo. AC-10
requires the last-used pseudo to be prefilled when a player returns on the
same device, and remain editable. AC-09 requires near-duplicate pseudos
(typos like "Lio_92" vs "Lio92") to be flagged for admin review, without
blocking or merging either submission. `players.pseudo` in the schema is
globally unique, making it, in effect, the identity key.

This raises a question the spec doesn't answer directly: is "prefilled from
device" backed by a server-side device token, or is it a purely client-side
convenience? And what happens if two different real people happen to type the
exact same pseudo string?

## Decision

The pseudo string typed at submission time is the identity — full stop. There
is no server-side device token table. AC-10's "prefilled from device" is
implemented entirely client-side (the last-used pseudo cached in the
browser's `localStorage`), pre-filling the input but leaving it freely
editable; the server never sees or stores a device identifier.

## Consequences

**Positive**
- No new table, no privacy surface for device tracking, nothing to reconcile
  if a player clears storage or switches devices — matches the "no mandatory
  personal data" constraint in spirit as well as letter.
- `predictions` naturally upserts on `(player_id, game_id)` via a pseudo
  lookup, which is exactly what AC-11 (resubmission overwrites) needs.

**Negative / accepted risk**
- Two different real people who happen to type the identical pseudo string
  become the same `players` row, merging their prediction history. This is a
  different problem from AC-09 (which is about the *same* person accidentally
  creating a second identity via a typo) and the spec does not ask for it to
  be solved — it is an inherent consequence of a free-text, no-login identity
  model, and no worse than what the existing spreadsheet-based process already
  tolerates.

## Options rejected

| Option | Why not |
|---|---|
| Server-side device token, pseudo as a separate display label | Adds a table and a new kind of identifier to reconcile against pseudo collisions, contradicting "no mandatory personal data" for a case the spec never asked to be solved |

## Revisit when

If exact-pseudo collision between distinct real players becomes a reported
problem (e.g. two regular players who happen to share a name), the fix is a
product decision (e.g. a disambiguating suffix), not an architecture change —
raise it with Lio rather than solving it speculatively now.
