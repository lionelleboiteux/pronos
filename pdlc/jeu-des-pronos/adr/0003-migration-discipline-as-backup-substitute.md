# ADR-0003: Mandatory expand/contract migrations plus manual pre-migration dumps

- **Status:** accepted
- **Date:** 2026-08-03
- **Unit:** jeu-des-pronos
- **Deciders:** Lionel Le Boiteux, Claude (Sonnet 5)

## Context

Supabase's Free plan has no daily backups and no point-in-time recovery —
confirmed via current (2026) documentation; PITR is a Pro+ add-on starting at
$100/month. Every other rollback mechanism in this build (Cloudflare Pages
instant promotion, Edge Function git-tag redeploy) assumes the database
underneath can tolerate `n-1` code running against it, which is only true if
migrations never destroy data the running code — old or new — still needs.
Without any vendor-provided recovery path, a destructive migration on this
stack is genuinely, unrecoverably one-way.

## Decision

Every schema change follows expand/contract, with no exceptions:
1. Expand — add new nullable columns/tables, no behaviour change, ship.
2. Migrate — backfill/dual-write if needed, ship.
3. Switch — Edge Functions read from the new shape, ship.
4. Contract — drop the old shape, in a *later* release, only after taking a
   manual `supabase db dump` and only once confident nothing depends on it.

A `supabase db dump` (or equivalent `pg_dump`) is taken and stored outside
Supabase before every migration that reaches step 4, as a deliberate,
scheduled build task — not assumed, not automatic.

## Consequences

**Positive**
- Steps 1-3 are each independently reversible by redeploying `n-1` code,
  matching the reversibility the rest of the stack already has.
- The one genuinely irreversible step (4) is deliberately delayed and gated
  behind a manual backup, rather than happening by default in the same
  release as the behaviour change that motivated it.

**Negative**
- This is pure process discipline with no tooling enforcement described here
  — it depends on whoever writes a migration actually following it. A future
  gate (red/verify) should check for this rather than trust it by
  convention alone.
- The manual dump step adds friction to what would otherwise be a single
  `supabase db push`.

**Neutral / accepted**
- No schema change and behaviour change are ever combined in one release,
  which was already the project's practice for other reasons (testability)
  and is now also a rollback-safety requirement.

## Options rejected

| Option | Why not |
|---|---|
| Rely on Supabase's own recovery tooling | Doesn't exist on Free; upgrading to Pro+PITR ($25+/mo plan, $100/mo PITR add-on) to get it contradicts the confirmed £0 budget |
| Accept the risk and skip backups | A single bad migration during the tight pre-season build window could destroy the only copy of real player data with literally no recovery path — disproportionate risk for the cost of a scheduled dump |

## Revisit when

If Supabase changes Free-tier backup terms, or if the project's budget
constraint is relaxed enough to justify Pro-tier PITR — re-verify current
terms before assuming this decision still holds, per the free-tier map's own
warning that these terms move.
