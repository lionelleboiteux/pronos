# jeu-des-pronos — Polish-gate evidence

> Gate 6 (polish) artifact. Mechanical lint/format/dead-code fixes only — no
> behaviour change. No file under `tests/` had an assertion touched.

**Status:** polish gate | **Author:** `bob-janitor` (Haiku), reviewed by
Claude (Opus 5) | **Date:** 2026-08-05
**Result:** 1 mechanical fix applied, suite re-run clean (118/118, `tsc`
clean) both by the janitor and independently by the reviewer. Several
judgment calls found — listed below as recommendations, not applied.

There is no ESLint/Prettier/Biome config in this repo. "Lint" at this gate
means manual review against Bob's TypeScript standard
(`~/.claude/bob/reference/standards-typescript.md`), not an automated tool run.

---

## 1. Mechanical fix applied

**`src/api/submitPrediction.ts` / `tests/support/seams.ts`** — the
idempotency `remember` dependency declared a `now: Date` second parameter
that nothing ever read: the real implementation in `server.ts`
(`(k) => void ctx.emailKeys.add(k)`) only takes one argument. Removed the
dead parameter from both the production type (`submitPrediction.ts`) and the
matching test-side type declaration (`tests/support/seams.ts` — a type
declaration of the seam's expected shape, not an assertion; no `*.test.ts`
file calls `remember` directly, confirmed by grep).

```diff
- remember(key: string, now: Date): void;
+ remember(key: string): void;
```
and the one call site:
```diff
- if (req.idempotency_key !== undefined) deps.idempotency.remember(req.idempotency_key, now);
+ if (req.idempotency_key !== undefined) deps.idempotency.remember(req.idempotency_key);
```

**Independent re-verification** (not just the janitor's own run):
`NO_COLOR=1 FORCE_COLOR=0 npm test` → 18 files, 118/118 passing. `npx tsc
--noEmit` → clean. `git diff --stat -- tests/` → only `seams.ts`, 1 line
changed, no assertion touched.

---

## 2. Recommendations — judgment calls, not applied

### 2.1 Two over-length functions the janitor's own scan missed

Independently re-checking function line counts against the 40-line standard
turned up two violations larger than anything the janitor flagged, so listing
them here rather than letting an incomplete scan stand as the final word:

| Function | Lines | Over cap by |
|---|---|---|
| `handleSubmitPrediction` (`src/api/submitPrediction.ts:77-191`) | **115** | 2.9x |
| `handleGameweekOverride` (`src/api/adminOverride.ts:82-158`) | **77** | ~2x |

`handleSubmitPrediction` in particular is the single largest function in the
codebase by a wide margin, and it wasn't caught. Splitting either responsibly
means deciding the seams (e.g. `handleSubmitPrediction`: validation → lock
check → persistence → idempotent-email side effect → telemetry, each already
visually separated by blank lines in the source, but decomposing means naming
and typing intermediate results, which is a design decision, not a mechanical
one) — recommended for a human or a future dedicated pass, not done here.

### 2.2 Already flagged by the janitor, confirmed correct on review

| Function | Lines | Note |
|---|---|---|
| `rescore` (`src/db/repository.ts:96-171`) | 76 | Confirmed. Mixes data retrieval, scoring, and two separate write paths (standings + telemetry) — splitting requires deciding whether "compute" and "persist" should separate. |
| `route` (`src/api/server.ts:284-325`) | 42 | Confirmed, only marginally over. A dispatcher with 4 sequential validation guards; each guard is one line, so splitting would trade length for indirection with little clarity gain — borderline enough to leave as a recommendation rather than a clear "should split." |
| `advanceLeague` (`src/domain/gameweekTransition.ts:49-105`) | 57 | Confirmed. State transformation plus event emission in one pass — separating "compute next state" from "emit events for the transition" is a real design choice (event ordering/correlation would need to be re-derived), not mechanical. |

### 2.3 Filename convention (`kebab-case` standard, currently `camelCase`)

11 files under `src/` violate the naming standard (`submitPrediction.ts`
should be `submit-prediction.ts`, etc. — full list in the janitor's run).
Correctly not applied: `tests/support/seams.ts` hardcodes every production
import path as a literal string (by design — see that file's own header
comment, "so Vite resolves it lazily and reports the real path in the
failure message"), so a rename touches a `tests/` file's import specifiers on
every seam, which is a bigger, riskier mechanical-looking change than it
first appears and better done as its own deliberate pass with the import
paths verified one by one, not folded into a routine polish gate.

### 2.4 Reviewed, no action needed

`src/api/server.ts:279`, `catch {}` inside `readBody`'s JSON-parse guard —
looks like the forbidden "bare catch that swallows an error," but on
inspection it's a deliberate, narrow control-flow conversion (a parse
failure becomes a typed `{ ok: false }` result, which the caller turns into a
`400 VALIDATION_FAILED`). Nothing is silently dropped that should propagate
or be logged; the error's only useful fact ("parsing failed") is already
captured in the return shape. Not flagged as a violation.

`src/db/repository.ts`'s `createRepository` (95 lines total across the file
including many small named inner functions it returns) is structurally a
factory, not one long procedural function — the 40-line standard is aimed at
single units of decision logic, and each function it returns (`rescore`
aside, see 2.2) is already reasonably sized. Whether `repository.ts` as a
*module* (443 lines) should eventually split into per-table files is a
separate, larger question than this gate's scope — noted, not acted on.

No other standards violations found on independent review: no `any`, no
`console.log`, no `var`, no loose `==`, no floating promises, no secrets in
source, `process.env` not read outside expected boundaries.

---

## 3. Verdict

Polish gate passes. One safe mechanical fix applied and independently
re-verified; every other finding is recorded above as a recommendation for a
human decision, per this gate's instruction not to silently apply judgment
calls. No test file's assertions were touched (confirmed via `git diff --stat
-- tests/`), and the full suite is unchanged at 118/118 with `tsc --noEmit`
clean.
