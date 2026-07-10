# Papercuts & deferred product decisions

Rough edges found in real use, deliberately parked here for a considered pass instead of
knee-jerk fixes. Each entry carries enough context to be picked up cold. This is not a bug
tracker — correctness defects get fixed when found; what lands here is UX friction and
product-shape questions that deserve real thought.

## Decided direction (2026-07-10)

**swng will offer affordances to terminate a game (or games) mid-round, and to terminate a
round.** Recorded as product direction; the design pass happens when this is picked up, not
before. Open questions to answer then:

- What a terminated game means for settlement: excluded from the archive's must-resolve set
  entirely, or recorded as abandoned with its partial standings? (Today `settleRound`
  requires every configured game to resolve — termination presumably shrinks that set.)
- Whether terminating a round means finalize-early (settle whatever resolved, mark the rest
  abandoned) or discard-the-round, or both as separate affordances.
- Who may terminate — any participant, matching the finalize rule?
- Event shape: termination is a round event like everything else (`game-terminated` /
  `round-terminated`?) so offline crews converge on it.

Until this lands, the only way to finalize a round with an unfinished game is to mark every
remaining hole picked-up for every player in that game (see papercut 1 — the error doesn't
tell you that).

## Papercuts

### 1. Finalize's "game never resolved" error is developer-grade

Reproduced 2026-07-10 against the live UI: score one hole, add a game, finalize → red text
`game "b28a56c9-…" never resolved` under the button. A raw game UUID, no statement of which
game, which holes, or which players are missing, and no hint that picked-up/conceded is the
completion path. The round is NOT stuck (the M6 settle-before-append fix means finalize just
refuses and can be retried) — but nothing on screen says so.

Wanted shape: name the game the way its chip does, enumerate what's missing, name the way
out — e.g. *"Stableford isn't finished — holes 2–18 still need scores for Pat. Score them or
mark them picked-up, then finalize."* Surfacing site: `RoundPage.tsx`'s finalize catch
(currently `setError(caught.message)`); the missing-holes computation is derivable from the
local fold (game config × cells), no backend change needed. Ties into the termination
direction above — an abandoned game should never force this dance at all.

### 2. AddCoursePage's hole grid is illegible to a sighted human

Confirmed by screenshot 2026-07-10: the 18-row grid renders **no visible column headers** —
the hole# | par | yardage | stroke-index order exists only in aria-labels, so a screen
reader knows the columns and a sighted golfer sees three unlabeled boxes (par's default 4 is
the only clue). Two more compounding issues: the grid overflows its card (CSS grid blowout —
the third column rides on the page background outside the dark card), and "SI" is unexplained
jargon (it's the row printed as "Handicap"/"HDCP" on most US scorecards; the "SI remaining"
hint assumes you already know this).

This is exactly the miss the M6 10-minute paper-card gate existed to catch; per the plan it
reopens AddCoursePage's *design*, not the milestone. The redesign pass should also decide:
visible headers vs. per-row inline labels, `minmax(0,1fr)` (or narrower fixed columns) for
the blowout, and one plain-language line about what SI is and why typing it exactly matters.

### 3. No in-app way to correct a mistyped course card (open decision)

Carried from the M6 final review (finding I2), still awaiting adjudication: the revise
endpoint (`POST /courses/{id}/tees` — same tee name ⇒ new version, supersedes, verifications
reset) shipped with zero web callers. A golfer who spots a transposed SI after submitting has
no in-app remedy; re-adding under a new name creates a duplicate course and pollutes search.
All the backend versioning machinery exists for exactly this flow. Options on the table:
a minimal "Edit this card" affordance (recommended; M7 or fast-follow), or a recorded scope
cut with the raw API as the stopgap. A related loose end rides along (M6 review finding M-i):
after a verify hits 409 `tee-set-revised`, the summary card re-fetches but CreateRoundPage's
already-fetched freeze source doesn't — a mid-setup revision race can freeze the stale
(internally consistent) card.

### 4. Process note: gates verify contracts, not legibility

Papercut 2 passed every automated gate because Playwright specs drive the UI through
aria-labels — precisely the layer that was fine. Human-legibility review (screenshot walks of
new surfaces, via the Playwright MCP browser) joins milestone close alongside the behavior
gates.
