# jeu-des-pronos — Consolidated email receipt

> Post-release addition, outside the formal Bob/John gate sequence (the
> project was already through `review`-pending at this point). Documented
> here for the same reason everything else in `pdlc/` is: so the next
> person — or the next session — knows why this exists and what was
> actually verified, not just what the code does.

**Status:** shipped, verified with one real send | **Date:** 2026-08-07

## What changed and why

AC-12 ("valid email → receipt") was built at the green gate as a per-match
side effect of `POST /v1/predictions` — one email per match submitted. The
user's actual old-system email (shown as a real example) is one
consolidated email per gameweek, listing every match. The frontend submits
one match per API call (10 calls for a 10-match gameweek), so the existing
per-match hook was the wrong shape for this — sending it for real as-is
would have meant up to 10 emails per player per week.

**Fix:** left `submitPrediction.ts`'s per-match mailer dependency as the
inert no-op it already was (still exercised by its own tests, untouched,
118/118 still passing) and added a separate route,
`POST /v1/leagues/{leagueId}/gameweeks/{gameweekId}/receipt`
(`src/api/sendGameweekReceipt.ts`), that the frontend calls once, after
every per-match submission in a batch has succeeded. It looks up
everything that pseudo picked in that gameweek
(`repository.getPlayerGameweekPicks`) and sends one email.

## Sending mechanism

Gmail SMTP (`denomailer`, `smtp.gmail.com:465`, TLS), not a transactional
API — the user's explicit choice, to keep the exact sender identity
`Fantasy Coach <fantasycoachfr@gmail.com>` their old system used. A
provider like Resend can't send convincingly as a gmail.com address
without owning that domain. Credential: `GMAIL_APP_PASSWORD`, a Gmail App
Password, stored as a Supabase Edge Function secret, never committed.

## What was actually verified, not assumed

- Local: routed, validated (`400` on a malformed email, `404` on an
  unknown pseudo/gameweek), and queried real seeded data correctly —
  without `GMAIL_APP_PASSWORD` set, so `email_sent: false` gracefully
  rather than crashing.
- **Real send, with the user's explicit permission**: called the deployed
  endpoint with `Le Raccoon`'s real, already-submitted Premier League
  gameweek-1 picks, sending to `fantasycoachfr@gmail.com` itself (the same
  account the credentials belong to — a self-contained test, not a third
  party). Response: `{"email_sent":true}`. Function logs for that request
  window show no errors.
- 118/118 existing tests still pass; `tsc --noEmit` clean on both the
  Node and Deno sides.

## Real bug found while building this, not after

A brand-new file (`src/api/sendGameweekReceipt.ts`) wasn't picked up by
the locally-running `supabase start` stack — `docker restart` on the
edge-runtime container alone didn't fix it either; a full `supabase stop`
+ `supabase start` was required. Root cause: Docker Desktop's bind-mount
on macOS doesn't reliably surface newly-*created* files to a container
that was already running when the file appeared, even though it hot-reloads
*edits* to existing files fine (used repeatedly earlier in this project
without issue). Worth remembering for the next new file added to a
function while the local stack is already running.

## Known gaps

- No automated test exists for `sendGameweekReceipt.ts` (no red-gate cycle
  was run for this addition — a deliberate, pragmatic trade-off for a
  small post-release fix, not an oversight to silently carry forward
  indefinitely).
- `openapi.yaml` was not updated with this new operation, so it isn't
  contract-fuzzed by Schemathesis and isn't documented in the frozen
  contract. Worth doing if this surface grows.
- Only one real send has been verified. Deliverability at real volume
  (Gmail's ~500/day cap, spam-folder behavior for the actual player base)
  is unverified — the project is a handful of players, so this is not
  expected to matter soon, but it isn't proven either.
