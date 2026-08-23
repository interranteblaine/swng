# swng — Arc log

Milestones **M0–M9** are recorded in `implementation-plan.md`. Everything after M9 shipped as
**arcs**: a design session producing a spec, a plan of SDD tasks, independent reviews, and a
controller-run close-out.

This file is the index of those arcs — **newest first**. Each entry is a pointer, not a record:
the spec holds the reasoning, the plan holds the tasks, git holds the diff, and `architecture.md`
/ `engineering-conventions.md` / `product.md` hold the rules that survived. Read this file to find
*which* arc changed a thing and *why it exists*; read the spec to find out what it decided.

**⚠ SUPERSEDED marks an arc whose model no longer exists.** Its spec is history, not design input
— do not build against it.

---

## 2026-08

### 2026-08-02 — A round plays a nine
`6c68e0e..1655dac`, merged `ff50150` · [spec](superpowers/specs/2026-08-02-round-plays-a-nine-design.md) · [plan](superpowers/plans/2026-08-02-round-plays-a-nine.md)

A round's hole count came from the card it froze, so "we played the back nine" was unsayable —
and the round it produced was silently wrong: `allocateStrokes` read stroke index across the whole
card, so a nine drawn out of an eighteen received a fraction of the typed strokes. Added
`HoleSelection` (`"all" | "front" | "back"`, optional — absence is true of every round ever
played, so no migration) on `round-created`, corrected by `round-holes-set`; one total function
`intendedHoles(teeSet, selection)`; `allocateStrokes` now **ranks the holes played** by stroke
index, byte-identical on a full card. Duplicate courses stay the right tool for playing the same
nine twice (one score slot per hole number) and the wrong tool for front/back — which holes you
played is a fact about the round, not the course.

### 2026-08-01 — A round has one date
`1a7b30a..7440ae0` · [spec](superpowers/specs/2026-08-01-round-played-date-design.md) · [plan](superpowers/plans/2026-08-01-round-played-date.md)

Back-dating a round played on paper. The defect underneath was bigger: `createdAtMs` meant both
*when the record was made* and *when the golf happened*, and history sorted by `finalizedAtMs`.
Now three fields, each with exactly one job — `playedAt` (the only date shown, grouped or sorted
by), `createdAt` (audit only; its gap from `playedAt` is the hand-entered signal), `finalizedAt`.
`round-created` gains required `playedAtMs`; `round-played-at-set` corrects it; one domain
function `playedAtMsOf(events)`. **Both stages migrated.** A retroactive round is a solo round —
"add him retroactively" was rejected on the `addCrewMember` precedent (nobody is conscripted).

### 2026-08-01 — The outbox drains itself, and never deletes a score
`ad91bc3..44fa3d9`, follow-up `738e305` · [spec](superpowers/specs/2026-08-01-outbox-drains-itself-design.md) · [plan](superpowers/plans/2026-08-01-outbox-drains-itself.md)

Offline sync was manual — M4 deferred retry cadence to "the UI" and no UI ever claimed it — and a
permanently-refused score was deleted from the only durable copy anywhere. Fixed in a load-bearing
order: stop deleting (`PersistedSync.rejected`) and stop misreporting (`recordScore` returns
`{duplicate:true}` before the status check) **before** automatic retry existed. Then two
backoff ladders (pass-keyed and socket-liveness-keyed), request timeouts, wake signals in the web,
and chrome that describes the queue rather than the socket. `LateScoreRefused` (EMF) is what earns
the right to build for the multi-device finalize hole — deliberately not built.

---

## 2026-07 — the strokes reckoning

### 2026-07-31 — Prod reads its own history
`986be8e..612a7ae` · [spec](superpowers/specs/2026-07-31-prod-reads-its-own-history-design.md) · [plan](superpowers/plans/2026-07-31-prod-reads-its-own-history.md)

The two strokes arcs renamed how a stroke count is stored, so HEAD could not read prod's own
rounds. The first design proposed a permanent tolerate arm in the schema the *client* parses on
every event forever — to read **15 records**. Owner rejected it on proportion. Migrated instead:
two guarded rename rules, 12 events + 3 snapshots, the 8 record lines left to re-derive off the
snapshots stream. **Nothing under `packages/` changed** — that is the arc's whole claim. See
`engineering-conventions.md` §4 for the tolerate-vs-migrate rule this established.

### 2026-07-30 — Strokes are typed, not derived
`8d9fef4..0e592ef` · [spec](superpowers/specs/2026-07-30-strokes-are-typed-design.md) · [plan](superpowers/plans/2026-07-30-strokes-are-typed.md)

The owner's field report, read a second time, was the evidence against the arc that shipped the
day before: the group did the subtraction in their heads and typed 20 and 0. A player's strokes
are now **one integer on the roster, default 0, editable by anyone** (`participant-strokes-set`).
What it deliberately did *not* collapse: **a card is absolute, a match is relative** — medal games
use each player's own number, matches play off the difference allocated from the hardest hole
down, and no test that counts dots can tell the two apart. `conceded` deleted (a gimme is a
score). Shipped the **golf-arithmetic AST fence** (generated from its axes after four hand-written
branch lists each shipped a hole), made stored reads **parse rather than cast**, and added the
finalize outbox guard.

### 2026-07-29/30 — Strokes come from what you shoot, not an index
`77fb675..c588406` · [spec](superpowers/specs/2026-07-29-relative-to-par-strokes-model-design.md) · [plan](superpowers/plans/2026-07-29-relative-to-par-strokes-model.md)

**Deleted `packages/domain/src/handicap/` whole** — WHS adjusted gross score, differentials, Rule
5.2a, course-handicap conversion, the allowance table, the plus-handicap render convention — and
replaced the whole pipeline with the number a first tee already speaks. Rating and slope stay
recorded on the course card (they are printed on the real scorecard) but feed no calculation.
`golfer/average.ts` (score − par over the last 10 fully-scored rounds) replaced the handicap
engine. Superseded by the arc above within a day on the *input* model; the deletions stand.

---

## 2026-07 — production readiness

### 2026-07-24 — Prod-readiness Arc C: production launch
`70282b5..04d23c6` · [spec](superpowers/specs/2026-07-24-prod-launch-arc-c-design.md) · [plan](superpowers/plans/2026-07-24-prod-launch-arc-c.md)

`swng-prod` on the `swng.golf` apex. No new stack code and no stage-name branching — the last
hardcoded per-stage knobs became typed `SwngStackProps` fields with beta-shaped defaults plus a
`STAGE_CONFIG` table, so **beta synthesizes byte-identical** while prod turns off
`USER_PASSWORD_AUTH`, sets a password policy, enables pool deletion protection and
`preventUserExistenceErrors`, and scopes origins to `swng.golf` only.

### 2026-07-24 — Prod-readiness Arc B: observability
`7b50d83..46b9515` · [spec](superpowers/specs/2026-07-24-prod-hardening-arc-b-design.md) · [plan](superpowers/plans/2026-07-24-prod-hardening-arc-b.md)

Deleted the 10 blip-pagers (per-function error + per-table throttle alarms); reshaped 5xx to a
non-transient M-of-N; added p95, WAF-blocked and signup-spike alarms. **EMF usage metrics** via
stdout (no `PutMetricData`): RoundsCreated / RoundsFinalized / Signups. One structured access-log
line per request. `swng-ops-${stage}` dashboard. An alarm on a near-zero metric was shipped and
owner-ruled back out the same day — alarms on near-zero metrics page on noise.

### 2026-07-23 — Prod-readiness Arc A: app hardening
`375512d..ac71edc` · [spec](superpowers/specs/2026-07-23-prod-hardening-arc-a-design.md) · [findings](superpowers/specs/2026-07-23-prod-readiness-security-findings.md) · [plan](superpowers/plans/2026-07-23-prod-hardening-arc-a.md) · [handoff](superpowers/handoffs/2026-07-23-prod-hardening-arc-a-handoff.md)

Eight closures: wire bounds (**request schemas only** — see `engineering-conventions.md` §4),
CSPRNG join codes, an O(N) rewrite of index-over-time, the unused Cognito `email` claim deleted,
`TOKEN_SECRET` moved from the Lambda env to a runtime Secrets Manager fetch with a self-healing
`appPromise`, two rate-based WAF ACLs, security headers + scoped CORS, and PITR + deletion
protection on the RETAIN tables.

### 2026-07-23 — Managed login on brand, and brand tokens are a package
`c2755ef..1ee38bf` · [spec](superpowers/specs/2026-07-23-managed-login-brand-and-brand-tokens-design.md) · [plan](superpowers/plans/2026-07-23-managed-login-brand-and-brand-tokens.md)

`@swng/brand` — a pure-data leaf (8 colors, 2 font stacks) extracted because a brand value had
crossed a package boundary. The web keeps its Tailwind `@theme`, pinned to the package by a
two-way test. Cognito **Managed Login v2** branded from those tokens (pool → `ESSENTIALS` tier);
Cognito *emails* are deliberately not branded.

---

## 2026-07 — the crew and the record

### 2026-07-23 — The crew page converges on the shared idioms
`31ddad0..15c918f` · [spec](superpowers/specs/2026-07-23-crew-page-ui-papercuts-design.md) · [plan](superpowers/plans/2026-07-23-crew-page-ui-papercuts.md)

Two owner-reported papercuts (invite URL overflowing, oversized roster buttons) fixed at the root:
the crew page had reinvented shared idioms and drifted. Routed through `ui/CopiedLinkLine` (which
already carried the `break-all` fix) and added `btnQuietDanger` for row-scale destructive actions.

### 2026-07-22 — "Played together" renders a round the canonical way
`3503450..25c548c` · [spec](superpowers/specs/2026-07-22-played-together-round-label-design.md) · [plan](superpowers/plans/2026-07-22-played-together-round-label.md)

The crew list rendered a raw locale date. Now the canonical `roundLabel` — facts on the wire
(`courseName`, `createdAt`), formatting in the web — with `dayCollisionChecker` lifted out of
HomePage as the one in-list collision rule.

### 2026-07-22 — The season is the record: chosen dates, no crown
`e0f1770..b6cc906` · [spec](superpowers/specs/2026-07-22-crew-seasons-are-the-record-design.md) · [plan](superpowers/plans/2026-07-22-crew-seasons-are-the-record.md)

Owner rejected crowning root and branch: **crowning requires a defined competition, and a crew
season is a tracking window that doesn't define one.** A season became a name + two chosen,
required, visible dates, with **time as its only state** (Live vs Final derived on read). Deleted
whole: close/reopen verbs and routes, `status`, the Jan-1 tiling rule, `stablefordTitle`, the
all-time surface. One conversion `seasonWindowOf` kept every existing fold byte-untouched.

### 2026-07-21/22 — The crew watches: window seasons, automatic scoreboard
`e362d94..bac0ed2` · [spec](superpowers/specs/2026-07-21-crew-scoreboard-window-seasons-design.md) · [plan](superpowers/plans/2026-07-21-crew-scoreboard-window-seasons.md)

Crews were "lacking and clunky" for one reason: **the crew only knew what you told it.** Every
member had to manually count each round into a season. Now the crew *watches* — it reads its
members' golf and is never fed it (automatic counting discloses nothing a stranger couldn't
already read on `/golfers/{id}`). `CountedRound` and both its routes deleted; one window feeds a
scoreboard and together-records (a round is "together" iff ≥2 current members' lines share its
roundId).

### 2026-07-21 — The season closes ⚠ SUPERSEDED
`0f8f244..a25a60a` · [spec](superpowers/specs/2026-07-21-close-season-design.md) · [plan](superpowers/plans/2026-07-21-close-season.md)

Organizer-only close/reopen verbs so Stableford titles could become real. **Deleted entirely the
next day** by "The season is the record" — editing the end date turned out to be the whole
lifecycle, which made the status flag redundant and the crown wrong in principle.

### 2026-07-21 — The index chart is finished ⚠ SUPERSEDED (model)
`ebe861d..52b5623` · [spec](superpowers/specs/2026-07-21-index-chart-polish-design.md) · [plan](superpowers/plans/2026-07-21-index-chart-polish.md)

A windowed, scaled, honest plot: last 20 rounds (the WHS window), nice integer bounds with a
minimum 4-point y-span so a quiet season looks quiet, no frame, fluid width, merged caption, date
anchors. The *index* it plotted was deleted on 2026-07-29; the charting principles (refusing to
draw noise in amplitude as well as in sample size) outlived it.

### 2026-07-21 — Analytics are read folds over sealed rounds
`422cd01..4fb65ad`, ruling wave `c894df5`+`4a5f216` · [spec](superpowers/specs/2026-07-21-analytics-read-folds-design.md) · [plan](superpowers/plans/2026-07-21-analytics-read-folds.md)

A 6-point binding model, converged after rejecting a fact-table/projector/manifest design for
rebuilding machinery this repo had already deleted twice: **the snapshot is the only truth; every
scope stores only a list of its rounds; exactly one performance cache; the crew folds snapshots at
read; the crew is the only leaderboard; the web renders served numbers.** One storage change:
`GolferRoundLine.holeResults?`. The ruling wave made **standings order domain truth**
(`aggregateSeason` sorts totally).

---

## 2026-07 — the round on the phone

### 2026-07-20 — The join code arrives with the credential
`7224ed3..6966888` · [spec](superpowers/specs/2026-07-20-round-page-papercuts-join-code-design.md) · [plan](superpowers/plans/2026-07-20-round-page-papercuts-join-code.md)

Four UI corrections plus a modeling error surfaced by a feature ask: the join code was stored
server-side but never *served*, so clients knew it only by happenstance of entry path. Now a
required `joinCode` on `JoinRoundResponse` at all three doors — **holding a participant token
means holding the code** — and it must never ride the event log or a `round-read` response, or a
watch link would leak the power to join.

### 2026-07-20 — The course handicap is correctable mid-round
`6265327..a2e36c5` · [spec](superpowers/specs/2026-07-20-mid-round-handicap-correction-design.md) · [plan](superpowers/plans/2026-07-20-mid-round-handicap-correction.md)

Retroactive and whole-round (a wrong number was always wrong), free by construction since nothing
snapshots strokes. The mechanism survived an owner probe: reusing `participant-joined` was wrong
because **a join is a presence fact**, and needing a guard to suppress half an event's meaning was
the tell. Shipped a dedicated event — later renamed `participant-strokes-set`.

### 2026-07-20 — Navigation is the nouns
`f32dcc3..54e12ad`, cleanup `46cc802`, correction `b060e23` · [spec](superpowers/specs/2026-07-20-navigation-design.md) · [plan](superpowers/plans/2026-07-20-navigation.md)

**The product is four nouns; navigation is the nouns.** Every noun has an address, every rendered
noun-name links to it. One backend route (`GET /golfers/{id}`) and one policy relaxation (a
finalized archive reads for any signed-in golfer). **One address per round** — `/rounds/:roundId`
resolves archive → your-live → honest fallback. Post-close owner correction: **a history row IS
the round**, so rows in round-representing lists are one whole-row link.

### 2026-07-19 — The brand reskin, the door, and the death of the 401
`1363921..51b51fb` · [spec](superpowers/specs/2026-07-19-brand-reskin-design.md) · [plan](superpowers/plans/2026-07-19-brand-reskin.md)

A field report (three identical "Sign in" buttons, a console 401 on every stale-session load) grew
into adopting the marketing identity end to end, owner-approved via rendered mockups: cream paper,
forest ink, gold as the pencil (**once per screen**), oxblood as the second ink (a closed job
list), system font (zero font files), square corners. Tokens in one `@theme` block, idioms in one
`ui/classes.ts`. Two sanctioned behaviour changes: the signed-out `/` became the landing page, and
`withAuth` refreshes proactively — killing the 401 structurally.

### 2026-07-19 — The card never changes, games open in one tap
`fdefdea..2c0f3bb`, fixes `835a6ac`, `2c0f3bb` · [spec](superpowers/specs/2026-07-19-standard-card-game-panels-design.md) · [plan](superpowers/plans/2026-07-19-standard-card-game-panels.md)

Four corrections from a field critique: **one standard card, always** (chip taps never touch the
grid — `ScorecardGridProps` has no game-typed prop, stable by construction); **scores clear** (an
additive `{kind:"cleared"}` arm the fold *retains* under HLC-latest, plus one accessor `cellAt`
replacing every raw cell read); **one tap, inline** (chips became disclosure buttons); and
**treatment stated in words** up front.

### 2026-07-19 — Games are legible
`e8bbad8..8b06dab` · [spec](superpowers/specs/2026-07-18-games-legibility-design.md) · [plan](superpowers/plans/2026-07-18-games-legibility.md)

Games were jargony and opaque. One principle: **each game's human meaning is domain truth in one
tested module and every surface renders through it** (`scoring/present.ts`). Engines expose their
per-hole trails on **live `GameState` only**, so the settled wire is byte-unchanged. Owner ruled
the five v1 games stay; Nassau is the recorded next game arc.

### 2026-07-18 — The golfer's record: index over time ⚠ SUPERSEDED (model)
`a4d4209..3c1c5cd` · [spec](superpowers/specs/2026-07-18-golfer-record-index-over-time-design.md) · [plan](superpowers/plans/2026-07-18-golfer-record-index-over-time.md)

A design correction: `metrics.trend` was an unlabeled `number[]` — a *rendering* (differentials
reordered for a sparkline) frozen onto the wire, drawing a confident line through noise. Replaced
with a rolling index chart gated under 8 rounds, "your typical 18", score-first history rows, and
the posted differential canonicalized to its real 0.1. The index model is deleted; the lesson —
**never put a rendering on the wire** — is not.

### 2026-07-18 — The domain boundary is restored
`e873642..ac880ea` · [spec](superpowers/specs/2026-07-18-restore-domain-boundary-design.md) · [plan](superpowers/plans/2026-07-18-restore-domain-boundary.md)

Not a feature — a correction to a broken boundary. The layering lint checked import *direction*
only, never whether a React view *re-derived* a golf result inline, so across milestones golf math
leaked into `apps/web`. Ten leaks moved byte-identically; `@swng/client` gained `foldAndScore`;
the **compute fence** was born. Its other half (the AST rule for inline re-derivation) came
2026-07-30.

---

## 2026-07 — handicap, briefly ⚠ ALL SUPERSEDED

These four arcs built and refined a WHS/swng handicap-index model that was **deleted whole on
2026-07-29**. They are listed for archaeology only. Do not build against them.

- **2026-07-17 — The index picker commits on tap; plus handicap** · `72d3a38..ffb6224` · [spec](superpowers/specs/2026-07-17-index-source-one-tap-commit-plus-handicap-design.md) · [plan](superpowers/plans/2026-07-17-index-source-one-tap-commit-plus-handicap.md)
  One tap = one commit; the plus-handicap convention moved into one tested `handicap/present.ts`
  and enforced by a whole-tree grep gate. *The gate technique outlived the model.*
- **2026-07-16 — The index is a SOURCE you choose** · `799ec85` · [spec](superpowers/specs/2026-07-16-handicap-index-source-model-design.md) · [plan](superpowers/plans/2026-07-16-handicap-index-source-model.md)
  Adopting your WHS index froze a copy that silently drifted. Fixed by modeling the index as a
  *source* resolved live. **Invariant: never store a computed number** — still true, now expressed
  as "an asserted integer, never computed at fold time" (`architecture.md`).
- **2026-07-16 — The handicap model is legible** · [spec](superpowers/specs/2026-07-16-handicap-index-strokes-model-design.md) · [plan](superpowers/plans/2026-07-16-handicap-model-legibility.md)
  Closed papercut 16's rating half — **unrated courses** enter, play and finalize. *That half
  survives:* rating/slope are optional as a pair and feed no calculation today.
- **2026-07-15 — Unrated courses plumbing** · [spec](superpowers/specs/2026-07-15-unrated-courses-handicap-model-design.md) · [plan](superpowers/plans/2026-07-15-unrated-courses-handicap-model.md)

---

## 2026-07 — courses, crews, identity

### 2026-07-15 — Course cards: the stored unit is the frozen unit
`6dc2d3f..8b6c5bc` · [spec](superpowers/specs/2026-07-15-course-cards-design.md) · [plan](superpowers/plans/2026-07-15-course-cards.md)

The course system stores exactly one kind of thing — **immutable cards, in lineages**. A
`CardRecord` wraps the exact `CourseCard` value rounds freeze (no translation function exists,
pinned by a same-object-reference test); every maintenance act is one whole-card supersession
guarded by one rule (the pointer must still name the card the caller reviewed). **Tee identity is
recorded at write time, never inferred.** Verification deleted whole — the trust model is
**transcription, not authority**. `StartRound` became a reference command.

### 2026-07-15 — Beta lives at beta.swng.golf
[plan](superpowers/plans/2026-07-15-custom-domain-beta.md)

An optional per-stage `web` prop resolved from a `STAGE_WEB` table — the first real stage config,
no stage-name branching in the stack.

### 2026-07-15 — Crew membership: invited in, accountable out
[spec](superpowers/specs/2026-07-14-crew-membership-design.md) · [plan](superpowers/plans/2026-07-14-crew-membership.md)

Membership is **invite links, 7-day expiry, one signer** — a `crew-invite` variant on the same
HMAC issuer, with every round-token verifier scope-narrowing to reject it. The **organizer** holds
remove and transfer, exactly-one enforced by construction. Deleted whole: the permanent join code
and `addCrewMember` — **nobody is conscripted; one path in.**

### 2026-07-14 — Pre-prod hardening D4a/D4b
[spec](superpowers/specs/2026-07-14-pre-prod-hardening-design.md) · [plan](superpowers/plans/2026-07-14-pre-prod-hardening.md)

The owner session that dispositioned the M10 hardening ledger. The handicap index moved to
computed-on-read (the stored snapshot and its accepted read-modify-write race deleted whole), and
the projector's stream source gained real poison-record handling with an SQS DLQ that is a
**metadata bookmark — rebuild is the re-drive.**

### 2026-07-13/14 — Accounts-only identity (the wall)
`515baac..` · [spec](superpowers/specs/2026-07-13-accounts-only-identity-design.md) · [plan](superpowers/plans/2026-07-13-accounts-only-identity.md)

Every round participant is a signed-in account; **ghosts, claims and anonymous rounds deleted
outright.** Added `participant-left` (presence per golfer = HLC-latest of {join, leave}, the same
mechanism as score cells) with settle-once departure rules. Identity is get-or-create on first
authenticated touch; Cognito is a pure authenticator (sub only). Join is always yourself.
**Old data tolerates forever** — stored rounds with ghost golferIds fold and render exactly as
written; the sealed leaf is the identity of record for its own participants.

### 2026-07-13 — A crew is a grouping, not a preset
`6baf36c..` · [plan](superpowers/plans/2026-07-13-crew-is-a-grouping.md)

The owner's call deleted every path by which a crew helped *run* a round: standing games, "Play
the usual", the setup-screen quick-add, and the co-membership consent arm. A claimed golfer gets
onto a card exactly one way — the person joining as themselves. Season standings aggregate the
**current roster only**; leaving drops your rows at the next read and rejoining restores them.
Membership is pure aggregation scope, stored nowhere.

### 2026-07-12/13 — The snapshot realignment: the round is a sealed leaf
`04b4caf..9a7815f` · [spec](superpowers/specs/2026-07-12-projection-realignment-design.md) · [plan](superpowers/plans/2026-07-12-snapshot-realignment.md)

A 16-task, 4-phase correction titled by its own rule: **every derived store references the round
inbound by `roundId`; the round points at nothing.** A dedicated `snapshots` table holds one
immutable `RoundArchive` per finished round, committed with `round-finalized` in one cross-table
transaction, so "finalized but no archive" is unrepresentable. The projector moved to the
snapshots stream; the golfer projection moved to stable keys; `rebuildProjections` became a paged,
cursor-resumable backfill; `crewId` was deleted from the round; `round-abandoned` became a real
terminal.

### 2026-07-14 — Papercut batch
[plan](superpowers/plans/2026-07-14-papercut-batch.md) — see `papercuts.md` for the live list.
