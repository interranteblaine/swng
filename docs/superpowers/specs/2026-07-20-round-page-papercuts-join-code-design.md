# Round-Page Papercuts + The Join Code Arrives With the Credential — Design

**Date:** 2026-07-20
**Origin:** Five owner field reports from live use of beta.swng.golf, verbatim: (1) "the clear
selection button actually doesn't clear it just closes the modal. there is already a clear
score button. suggest renaming." (2) "cells under name in scorecard aren't aligned" (with
screenshot). (3) "share round shouldnt be at the top of the screen that is the least used
button push it to the bottom." (4) "finalize round should be below games and above leave
scrap and share." (5) "shouldnt join code be a link or atleast copy?"
**Status:** Approved (owner, 2026-07-20). Item 5's design was re-derived twice under owner
probing — the final model ("metadata on the round, served to only round participants,
delivered with the credential") is the owner's own framing, confirmed.

## 1. The four UI corrections (items 1–4)

**Rename "Clear selection" → "Cancel"** (`ScorePad.tsx`). The button posts nothing — it only
closes the pad (`onCancel`). The name is an M5-era leftover from when tapping a cell was a
"selection," and it now reads as a data action sitting next to `Clear score`, which actually
clears. "Cancel" is the exact word every other bottom sheet on the page already uses
(Finalize/Scrap/Leave confirm dialogs). Behavior unchanged.

**Scorecard cells align under names** (`ScorecardGrid.tsx`). Diagnosis: each score cell
button has `min-w-14` but not `w-full`, so when a participant's name widens its column the
header name centers while the cells shrink-wrap at 56px and sit at the column's left edge —
the misalignment in the owner's screenshot. Fix: the cell button gains `w-full`, filling its
column — cells center under names at every column width, and the tap target grows. One class.

**Action order** (`RoundPage.tsx` `LiveRound`, and `ResultsView.tsx`). The owner's ruling:
Share is the least-used button and goes last; Finalize sits below games and above the
leave/scrap/share cluster. New `LiveRound` order, top to bottom:

1. `StandingsHeader` (chips + panels)
2. `ScorecardGrid`
3. `SetupPanel` (join code · roster · add game)
4. `FinalizeControl`
5. `LeaveControl`
6. `ScrapControl`
7. `ShareButton` (dead last)

(Leave/Scrap/Share in the owner's own listed order.) `ResultsView` renders `ShareButton` as
its very first element today — same principle, so it moves to the bottom of that view too
(after the Final card section). No component's internals change; this is composition order
only.

## 2. Item 5 — the model correction, then the affordance

### The modeling error being fixed

The join code is **metadata on the round, visible only to participants** (the owner's
framing). Server-side it already lives that way — stored on the round's meta item at
creation, forever. But no API ever served it back: the client knew the code only by
happenstance of entry path (the create response includes it; the join form echoes what you
typed) and stored it as **device state** inside the per-round credential. When the third
entry path arrived (open-from-home re-mints a token on a new device), the assumption
silently broke — `openLiveRound` saves `joinCode: ""` and the Join code panel renders blank.
That was recorded as papercut 19. It is not a papercut; it is a round fact modeled as a
device fact.

### Where the code is served — and where it must not be

The join code is the round's **invite capability** — the power to put someone on the card.
That scopes it:

- **Not in the round's event log**, even though round facts normally live there — spectators
  fold the same log (`round-read` auth serves both scopes), so a read-only watch link would
  leak the power to join as a player. Rejected on capability grounds, not convenience.
- **Not on the live read/pull responses** — the pull endpoint is the shared
  participant-or-spectator surface above; serving the code there means either the leak or
  one endpoint answering differently by caller scope. And the code never changes, so
  re-delivering it on every pull buys nothing. Rejected.
- **On every participant-token response** — the three doors into a round (create, join,
  re-mint) each end with the server handing the device its participant credential, exactly
  once per device per round. The token and the code are the same kind of thing: capabilities
  you hold as a participant. The code rides that reply.

### The invariant

**Holding a participant token means holding the round's join code.** `joinCode` is a
REQUIRED field on `JoinRoundResponse` (the shape both `POST /rounds/join` and
`POST /rounds/{roundId}/token` return; `StartRoundResponse` already carries it). No code
path produces a token without the code, so the blank-panel state is unrepresentable going
forward — the client's per-device copy becomes a plain cache of a uniformly-served fact,
not path-dependent state.

- `joinRound` echoes `command.code` — the lookup just matched it exactly, so it IS the
  canonical stored code; no extra read.
- `mintParticipantToken` reads it via a new `RoundStore.getJoinCode(roundId)` port method
  (a GetItem on the round meta item the adapter already writes). A missing meta item throws
  `round-not-found` — existing vocabulary, no new codes.
- Route count, auth tiers, and request shapes are all unchanged.

### The affordance — "Copy invite link"

`/join?code=XXXXXX` already seeds the join form and survives the sign-in round trip
(`returnTo`), so the receiving path exists whole. The Join code panel (`SetupPanel`) keeps
the big code (read it aloud on the tee) and gains one quiet button, **"Copy invite link"**
(`btnQuiet` — the text-register idiom): tapping it copies
`${window.location.origin}/join?code=${joinCode}` and then ALWAYS shows the raw URL with
"Link copied — " / "Copy this link — " ahead of it — `ShareButton`'s exact clipboard
discipline (clipboard access can silently fail; a link is useless if the only sign of
success is a vanished toast). A copy affordance, not a tappable link: the person looking at
the panel is already in the round; the link's only job is to be handed to someone else.

**Rejected — client-only gating** ("show Copy only when this device knows the code"): ships
a feature that unpredictably disappears based on entry path, building on the known hole.

## 3. What doesn't change, and the one legacy tolerance

- No new routes, no auth changes, no event-log change, no domain change, no data migration.
- The spectator share link (`ShareButton`) is a different capability (read-only watch) and
  is untouched beyond its position.
- **Legacy device credentials:** a device that entered a round via re-mint BEFORE this
  deploy has `joinCode: ""` cached. Its panel stays blank (and the Copy button hides on the
  empty string — a one-line legacy guard, commented as such) until the golfer re-enters the
  round by any door, which overwrites the cached credential. Accepted: beta-grade, dies on
  next entry, no self-healing machinery.

## 4. Deploy

**Lambda-first, then `publishWeb`** — the new bundle's response schema REQUIRES `joinCode`,
so it parses only against the new lambda; the old bundle ignores the extra field (Zod
strips unknown response keys). The reverse order breaks every join until refresh. No wipe,
no migration.

## 5. Testing & gates

- **Contracts:** `joinRoundResponseSchema` requires `joinCode`; round-trip test.
- **Application:** `joinRound` returns the request's code; `mintParticipantToken` returns
  the stored code (fake store); missing meta → `round-not-found`.
- **Adapter (contract tests, DynamoDB Local):** `createRound` → `getJoinCode` round-trips;
  unknown round → `undefined`.
- **Web:** ScorePad tests renamed to Cancel; SetupPanel tests — Copy invite link copies the
  origin-relative URL and shows the visible fallback, hides on empty code; JoinRoundPage /
  `openLiveRound` save `response.joinCode`.
- **e2e (root):** every join in the suite already parses through `joinRoundResponseSchema`,
  so the required field is asserted live on each `e2e:beta` run; one explicit equality
  assertion (`joined.joinCode === started.joinCode`) added to the round-slice case.
- **e2e (browser):** `handicapCorrection.spec.ts` enters its round via the re-mint path —
  it gains the assertion that the Join code panel SHOWS the round's code (the live proof
  papercut 19 died); `support.ts`'s stale "re-mint carries no join code" comment updated.
- `pnpm validate` green at every commit; close-out is the standard controller-run gate
  (deploy lambda-first → publish web → e2e:beta → e2e:field → adversarial USE pass on
  beta.swng.golf **with screenshots of every changed surface** — the reordered page, the
  aligned card, the copy affordance — per the eyes-on-pixels close-out rule).
