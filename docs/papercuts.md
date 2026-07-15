# Papercuts & deferred product decisions

Rough edges found in real use, deliberately parked here for a considered pass instead of
knee-jerk fixes. Each entry carries enough context to be picked up cold. This is not a bug
tracker — correctness defects get fixed when found; what lands here is UX friction and
product-shape questions that deserve real thought.

## Decided direction (2026-07-10) — LANDED (M7 Tasks 1/6, gated by Task 8)

**swng will offer affordances to terminate a game (or games) mid-round, and to terminate a
round.** Recorded as product direction; the design pass happens when this is picked up, not
before. Open questions to answer then, and how they were resolved:

- What a terminated game means for settlement: excluded from the archive's must-resolve set
  entirely, or recorded as abandoned with its partial standings? (Today `settleRound`
  requires every configured game to resolve — termination presumably shrinks that set.)
  **Resolved: excluded entirely** — `settleRound` (`domain/round/archive.ts`) filters
  terminated games out of the must-resolve set and out of `results`; the config stays in
  `games` (audit) and the archive records `terminatedGameIds` so the record stays honest.
- Whether terminating a round means finalize-early (settle whatever resolved, mark the rest
  abandoned) or discard-the-round, or both as separate affordances.
  **Resolved: composition, not a new lifecycle state** — "End unfinished games & finalize"
  terminates every unresolved game, then runs the existing finalize; there is no separate
  "terminate the round" event.
- Who may terminate — any participant, matching the finalize rule?
  **Resolved: yes**, same rule as finalize.
- Event shape: termination is a round event like everything else (`game-terminated` /
  `round-terminated`?) so offline crews converge on it.
  **Resolved: `game-terminated`** — envelope identical to every other round event; the fold's
  terminated set is a set union (commutative, idempotent, tolerant of arriving before its own
  `game-added`). No `round-terminated` — round termination is the composition above, not its
  own event.

Landed in M7 Task 1 (domain), Task 6 (web: the "End game…" chip affordance and the finalize
dialog's unresolved-games list), gated end-to-end by Task 8's termination-coverage addendum in
`apps/web/e2e/fieldTest.spec.ts`.

## Papercuts

### 1. Finalize's "game never resolved" error is developer-grade — ADDRESSED (M7 Task 6/8)

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

**Landed:** M7 Task 6's `finalizeReadiness.ts` (`unresolvedGames`) computes exactly this from
the local fold and `RoundPage.tsx`'s finalize dialog now lists it by name — e.g. "Stableford —
holes 11–18 unscored for Pat, Quinn" — with "End unfinished games & finalize" (terminate each,
then finalize) as the one-tap way out; `caught.message` is gone from the surfaced error
entirely. The termination direction itself (this doc's "Decided direction" above) shipped
alongside it: `game-terminated` in the round log, excluded from `settleRound`'s must-resolve
set. Re-verified end to end by Task 8's gate (`fieldTest.spec.ts`'s termination-coverage
block): the dialog's unresolved list, the end-and-finalize composition, and `ResultsView`'s
"Ended" badge on the terminated game all checked against the live system.

### 2. AddCoursePage's hole grid is illegible to a sighted human — ADDRESSED (M7 Task 7)

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

**Landed:** M7 Task 7 added a sticky `Hole | Par | Yards | SI` header row, fixed the grid
blowout (narrow explicit columns, verified to stay inside the card at 375px), and a
plain-language line under the SI hint ("SI = the Handicap/HDCP row on your scorecard — 1 is
the hardest hole. Type it exactly as printed."), with the 18-row keyboard-fill behavior and
its own tests unchanged. Screenshots at `.superpowers/sdd/screenshots/add-course-{375,
375-filled,desktop}.png` (gitignored, controller review only — papercut 4's own discipline).

### 3. No in-app way to correct a mistyped course card — ADDRESSED (M7 Task 7, I2 approved)

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

**Landed:** the user approved I2 (not vetoed) — M7 Task 7 shipped `EditCoursePage.tsx`
(`/courses/{courseId}/edit`, linked from `CourseSummaryCard`'s "Edit this card"), pre-filling
the same grid component `AddCoursePage` uses with the current tee's values and posting
`POST /courses/{id}/tees` under the same tee name (a new version, verifications reset — the UI
says so: "Saving creates a corrected, unverified version"). M-i closed alongside it: both the
verify-409 re-fetch and the edit flow's own return hand-off call one `onCourseRefreshed`
callback, which `CreateRoundPage` uses to replace its held (frozen) `CourseView` so a mid-setup
revision can no longer freeze a stale card. Screenshots at `.superpowers/sdd/screenshots/
edit-course-{375,desktop}.png`.

### 4. Process note: gates verify contracts, not legibility — and not flows

Papercut 2 passed every automated gate because Playwright specs drive the UI through
aria-labels — precisely the layer that was fine. Human-legibility review (screenshot walks of
new surfaces, via the Playwright MCP browser) joins milestone close alongside the behavior
gates.

**Extended after M7's close (2026-07-10):** the user's first real smoke found two claim-flow
reachability bugs a fully green pipeline missed — the claim affordance was suppressed on the
device's own roster row, and unreachable entirely on finalized rounds (fixed same evening,
`342d2e5`). Root cause was structural: every pipeline layer verifies conformance to what the
plan wrote, and the e2e's own convenience choices (claim mid-round, from a non-session row)
routed around exactly the paths a person takes. Screenshot walks check pixels, not paths. So
the standing discipline gains a second half: **before a milestone closes, the controller
personally drives the milestone's primary user flows in a real browser as a first-time user**
(not the plan's author-imagined scenario), and plan-time gates must include the unmodified
primary path — API shortcuts are allowed only in steps that are not the thing being gated.

### 5. Claiming a fresh ghost names the profile after the account, not the roster row — ADDRESSED (M8 Task 5)

Found in the M7 close flow-walk (2026-07-10): claim "Walker" on a roster and your profile
comes back named after your email localpart (e.g. `flowwalk-m7`), because
`POST /golfers/claim` carries only `{ golferId }` — the server has no round context to read
the roster name from, so a first-claim's lazily-created golfer row falls back to the
JWT-derived default. The name is editable on ProfilePage, so it's a wart, not a wall. Wanted
shape: the client sends the roster row's name alongside the id (it has it on screen), or the
claim use case resolves the name from the round the claim was made in. Fits naturally in
M8's join-as-yourself identity work.

Landed in M8 Task 5 (commit `236809c`): `claimGolferRequestSchema`
(`packages/contracts/src/golfers.ts`) gained an optional `name`, applied only on the branch
that lazily CREATES the target golfer row (`golferStore.claim`'s own port doc: a claim binding
an already-ghosted, unclaimed row never renames it, no matter what name is passed) —
`ClaimAffordance.tsx` sends the roster row's own `rowName` alongside `rowGolferId` on every
claim, so a fresh claim's profile is named after the row you clicked, not your email. Exercised
live by `crewSeason.spec.ts`'s own mid-season claim step (Task 7).

### 6. App sign-out doesn't end the Cognito hosted-UI session — CLOSED (M9 Task 2)

Found in the M7 close flow-walk (2026-07-10): "Sign out" clears the app's local tokens but
leaves Cognito's own hosted-UI session cookie alive, so the next "Sign in" can silently
re-authenticate as the previous account without ever showing the login form. Confusing on a
multi-account device and a real concern on a shared one. Fix shape: sign-out redirects
through the pool's `/logout` endpoint (which clears the hosted session and returns to a
registered logout URL). Belongs with M9's auth hardening (the logout URLs are already
registered on the client).

**Landed (2026-07-11):** M9 Task 2 (commit `5561c76`) shipped the fix shape named above
exactly — `useAuth.ts`'s `signOut()` now clears local tokens and redirects through Cognito's
own `/logout` endpoint; `apps/infra-cdk/lib/swngStack.ts`'s `UserPoolClient.logoutUrls` gained
`${origin}/` for each registered origin. The deploy's own live smoke (a `/logout` redirect
round-trip, `curl -I` → 302) confirmed the endpoint change at deploy time; the milestone's
separate controller close-out flow-walk re-confirms it end-to-end in-browser (sign out, sign
in again — a fresh login form, not a silent re-authentication as the previous account).

### 7. Rounds played before signing in strand their ghosts (one claim per account) — CLOSED, write-off recorded (M8 plan decision)

Field evidence from the user's own account (2026-07-10): three rounds created while signed
in = three distinct ghosts (the web mints a fresh golferId per round; being signed in links
nothing — that's M8's join/create-as-yourself). An account can claim exactly ONE golfer in
v1; `GolferMerged` was explicitly scoped out. So a real user's pre-claim history is mostly
unclaimable — the no-merge cut bites the primary flow, not an edge. M8's identity work must
pair join-as-yourself with an explicit decision about pre-existing rounds: bulk-claim,
merge, or an accepted write-off stated to the user.

Resolved as a recorded write-off, not a feature (M8 plan, flagged for and confirmed at plan
review: "Stranded pre-M8 rounds are a recorded write-off"). Rounds played before the as-self
flow existed — or before this milestone at all — whose ghosts differ from the one golfer an
account eventually claims or creates stay off that account's record, permanently: `GolferMerged`
(merging two `GolferId`s' histories into one) remains explicitly out of v1 scope, unchanged by
M8. This is stated honestly, not swept past: it includes the project owner's own two finalized
M7 rounds, played signed in before M8's play-as-yourself existed — under three distinct ghost
golferIds that none of M8's work retroactively reconciles with whichever golfer the account
goes on to claim or create. Going FORWARD, the papercut itself is what M8 actually fixes: a
round created or joined while signed in is now the account's own golfer from the moment it's
created (M8 Task 5's as-self flow, `CreateRoundPage`'s `asSelf` branch) or a crew's own STABLE
ghost that any one claim adopts whole (`crewSeason.spec.ts`'s mid-season claim step, Task 7) —
so this exact gap cannot recur for anything played from M8 onward.

### 8. Profile's set-your-name alert offers "Go to profile" from the profile itself — ADDRESSED (papercut batch, 2026-07-14)

Observed 2026-07-13 (crew-is-a-grouping final review). When the crews section moved from
HomePage to ProfilePage, the join-by-code `golfer-required` alert kept its copy byte-identical
— deliberately, that was the relocation rule — so "Set your name on your profile before
joining a crew. Go to profile" now renders with its link pointing at the page you're already
on, a few hundred pixels below the very name field it's asking you to fill. Behavior is
correct (the join is properly gated until identity resolves); the copy just wasn't rethought
for its new home. Wanted shape: on /profile the alert should say "set your name in the form
above" (or focus the name input); the link phrasing only ever made sense from elsewhere.
Surfacing site: `ProfilePage.tsx`'s crews join-by-code error branch.

**Landed (papercut batch, commit `77af0c6`):** the alert now reads "Save your name in the
form above first, then join the crew." — the self-link is gone (`grep "Go to profile"` on the
file returns zero). Web-copy-only by design: post-wall this arm is defensive-only anyway,
since AuthProvider's GET /me get-or-creates a golfer before the join form is usable, and the
backend's `membership.ts` rule (a crew mutation never lazily mints someone's own profile) is
a recorded position this batch deliberately did not overturn. CrewCreatePage's sibling arm
was left alone — its link points there from a *different* page, which was always correct.

### 9. A season whose contributors all left the crew reads "Standings build as rounds are counted" — ADDRESSED (papercut batch, 2026-07-14)

Observed 2026-07-13 (crew-is-a-grouping final review). Members-only aggregation (spec §11a:
lines for current roster members only) means a season can hold counted rounds whose every
contributor has since left the crew — the ledger computes empty, and `SeasonPanel` renders the
zero-state copy, which is untrue in that corner: rounds ARE counted, there's just no current
member in them to show. Rare by construction (requires counted rounds + full contributor
departure) and self-healing (anyone rejoining restores their rows at the next read). Wanted
shape: distinguish "no rounds counted yet" from "no current members appear in this season's
rounds." Surfacing site: `SeasonPanel.tsx`'s empty-ledger branch beside the counted-rounds
list, which already shows the rounds and makes the mismatch visible.

**Landed (papercut batch, commit `77af0c6`):** the empty-ledger branch now splits on
`standings.rounds.length` — zero counted rounds keeps "Standings build as rounds are
counted."; counted rounds with an empty ledger renders "No current members appear in this
season's counted rounds." beside the round list that makes the mismatch visible.

### 10. Home's signed-out device-credential list can only ever surface pre-wall relic tokens — ADDRESSED (papercut batch, 2026-07-14)

Observed 2026-07-14 (accounts-only "the wall" final review). `HomePage.tsx` still renders a
list built from `credentialStore.list()` — the per-device scoring tokens the old anonymous/ghost
join path saved to localStorage. Post-wall nothing writes new device credentials from the join
flow (every seat is an account, and a signed-in golfer's "Your rounds" comes from
`GET /me/rounds/live` by identity), so this list can only ever show tokens left over from before
the wall. Worse, those rows render as bare names with no course or date (they predate the
`roundLabel` designation), and the one thing the list still technically enables — re-entering a
live round on this device without signing back in — now has a straight product answer: sign in.
Wanted shape: delete the signed-out device-credential list outright and render `SignInCta` in
its place (the join-link funnel is the one way onto a card). Surfacing site: `HomePage.tsx`'s
`credentialStore.list()` block and its signed-out branch.

**Landed (papercut batch, commit `77af0c6`):** the wanted shape exactly — the device list,
its `credentialStore.list()` read, and the `list()` method itself (HomePage was its last
consumer) are deleted; the signed-out "Your rounds" section renders
`SignInCta` ("Sign in to see your rounds."). The per-round credential `load`/`save` survive —
RoundPage's scoring token and home's re-mint path still use them.

### 11. A settle-omitted departed participant keeps their LIVE# presence pointer until the 36h TTL — ADDRESSED (papercut batch, 2026-07-14)

Observed 2026-07-14 (accounts-only "the wall" final review). A golfer who seats a round (which
writes a `LIVE#<roundId>` presence pointer, `rounds/presence.ts`) but then leaves it with zero
scores and zero games can be omitted from `archive.participants` at finalize. `projectArchive`'s
presence-cleanup loop iterates `archive.participants`, so a participant not in the settled archive
never gets their pointer cleared — it survives on the round until its 36h TTL. Effect: their home
"Your rounds" (`getMyLiveRounds`, keyed off the LIVE# pointer) lists a round that is already
finished, and opening it 403s them (they aren't in the archive the round now points at). Bounded
and self-healing — the TTL reclaims the pointer within 36 hours — but confusing while it lasts.
Wanted shape: clear presence over the round STATE's full seated roster rather than the settled
archive's participants, so a settle-omitted seat's pointer is still removed at finalize. Surfacing
site: `projectArchive.ts`'s `deleteLive` loop (iterates `archive.participants`).

**Landed (papercut batch, commit `86f7e5d`):** presence-cleanup is now its own pass in
`projectArchive` over the ever-seated roster — every golferId with a `participant-joined`
event in `archive.events` (the archive's canonical replay source, equivalent to the state's
seated roster) gets `deleteLive`, unconditionally: no account-boundness check (deleting a
never-written pointer is a no-op needing no golfer read) and no dependence on
`archive.participants`. Lines/index projection is untouched — still account-bound over the
settled participants. Pinned by a test that drives the real `settleRound` through the
omitted-departure case (Bo joins, leaves scoreless and gameless, is omitted from the archive,
and his pointer is still cleared).

### 12. The name-prompt's error arm renders raw server text, now duplicated across two funnels

Observed 2026-07-15 (crew-membership final review). `CrewJoinPage.tsx`'s NamePrompt renders
`caught.message` for an `ApiError` — against the M7 never-raw discipline — because it copies
`JoinRoundPage.tsx`'s own name-prompt byte-for-byte, which has carried the same arm since the
accounts-only funnel landed. Pre-existing class, not arc-introduced; both sites fail together.
Wanted shape: one shared name-prompt component (or at least a shared error-humanizing arm), so
the copy discipline and the duplication get fixed by the same change. Surfacing sites:
`CrewJoinPage.tsx` NamePrompt error arm, `JoinRoundPage.tsx` name-prompt error arm.

### 13. Dead `refreshedCourse` plumbing pins a return-flow that no longer exists

From the course-cards arc's final review (2026-07-15). `CreateRoundPage.tsx`'s location-state
effect still handles `state.refreshedCourse`, `handleCourseRefreshed` still threads into
`CourseSummaryCard`'s `onCourseRefreshed` prop, and a green test still pins the "edit-flow
return hand-off" — but the new EditCoursePage navigates to `/courses/${id}` on success and
never back to `/create` with that state. Nothing sets the key; the comment claiming T6 would
restore it is false. Harmless at runtime (worst case a stale history entry replays an
old-shape CourseView and the server 400s), but a fresh reader is misled and the test asserts
a flow with no production setter. Wanted shape: delete the effect arm, the state key, the
handler thread, and the zombie test — or a real editor return-flow if one is ever wanted.

### 14. The add-tee editor's 409 re-seed discards a fully-typed new tee

From the course-cards arc's final review (2026-07-15). `EditCoursePage.tsx`'s
`card-superseded` handler re-seeds the whole form from the fresh card — correct for edits
(the base changed under you), but in add-tee mode it blanks the new tee's name/rating/slope
and all ~30 typed grid cells even though the new tee conflicts with nothing that changed.
Spec-conforming and the race is rare (concurrent maintenance on one course). Wanted shape:
preserve the in-progress new-tee column across the re-seed; refresh only the pass-through
tees and `supersedes`.

### 15. Stale M6-course-aggregate analogy comments survive the deletion

From the course-cards arc's final review (2026-07-15). Comment-only: `ports/golferStore.ts`
("mirrors CourseStore (courseStore.ts)" — deleted file), `ports/crewStore.ts:32`,
`retryOnConflict.ts:12`, `crews/crewSlice.test.ts` ("createFlakyCourseStore harness"),
`createDynamoCrewStore.ts:43`, and `CourseSummaryCardProps.onChangeCourse`'s "Absent on
AddCoursePage's own post-add summary" (that page no longer renders the component). Sweep
opportunistically next time each file is touched.

### 16. Unrated courses are UNUSABLE — a real product gap, design session required

Owner-raised (2026-07-15, during the course-cards rollout), then escalated same day with a
field report: the owner played a 9-hole unrated course — a favorite pre-work spot — and the
app was unusable for it. This is a real gap under "for the golf you actually play," not a
polish item. **Owner ruling: needs a proper design session; the sketch below is a
dependency analysis, NOT the design.** The session should cover what "usable" means
end-to-end for casual/unrated golf — entry, join, games, what the history line and profile
show for non-posting rounds, and the adjacent SI-less-card half (dots allocation breaks
without SI; gross-only games or allocate-by-agreement is a product decision). Deliberately
queued until AFTER the course-cards workstream closes.

Dependency facts (verified in code, for the future session): validation requires rating
30–90 and slope 55–155, so a course with no published rating (par-3, executive, many
9-holers) can only be entered by inventing numbers — which flow silently into WHS
differentials and the handicap index. Rating/slope feed EXACTLY one computation (the
differential); games/dots/scoring use the golfer-typed course handicap + stroke index and
never touch them, and `GolferRoundLine` already supports absent ags/differential (the
"incomplete" path). The real-WHS anchor: unrated courses don't post. Whatever the design,
it has zero contact with sealed rounds or card identity.
Adjacent-but-different: SI-less cards would break dots allocation — that half needs a
product decision (gross-only games?), not just optionality; explicitly out of this entry.
