# Mid-Round Course Handicap Correction — Design

**Date:** 2026-07-20
**Origin:** Owner field report: "course handicap cannot be updated mid round." A player who
entered the wrong course handicap at the tee (typo, forgot the 9-hole halving, misjudged an
unrated course) has no way to fix it once the round is live — the number is frozen into the
`participant-joined` event and every surface renders it read-only.
**Status:** Approved (owner, 2026-07-20). The event-mechanism decision was revised in review:
the owner probed "why is it a participant-joined event?" and the re-derivation replaced
seat-event reuse with a dedicated event (§3).

## 1. The problem

Course handicap enters a round exactly once, at the tee (`StartRoundRequest.host.courseHandicap`
/ `JoinRoundRequest.courseHandicap`), frozen into the seat's `participant-joined` event. There
is no route that updates seat data mid-round (`POST /rounds/join` actively rejects a re-join
while seated: `golfer-already-in-round`), and no UI affordance touches CH after join — the
roster renders it as static text.

Meanwhile nothing downstream ever snapshots it: the scorecard dots
(`courseHandicapAllocation`), all five game engines (`gameStrokeAllocation` → per-kind
`chOf`), AGS (`handicappingFor`), and the archive all read `participant.courseHandicap` live
from the folded roster on every compute. The model is already correct for corrections; only
the write path and the affordance are missing.

## 2. Semantics — retroactive, whole round (the ruling)

**A CH correction re-strikes the entire round: dots move on already-played holes, every game
standing recomputes, and the archive records the corrected number.** Golf doesn't have
mixed-handicap rounds — if your CH was entered as 13 and should have been 18, it was *always*
18; every hole scored against 13 was mis-struck. Correcting the whole card is the honest fix,
and it matches the product's correction ethos everywhere else (a mis-tap is clearable; the M5
field test celebrates a mid-round score correction that moves a 5-skin pot).

This is also what the compute layer does natively (§1): because nothing captures strokes at
add-game time, retroactivity requires **zero** new machinery.

**Rejected — "from this hole forward":** needs an effective-CH-as-of-hole concept captured
onto game configs (machinery that doesn't exist), produces a card no golfer can reason
about, and contradicts the correction model everywhere else in the product. A group that
genuinely renegotiates strokes mid-round is playing a different game, not correcting a
handicap.

## 3. The event — `participant-handicap-set`, dedicated and narrow

A new round-event arm, additive/append-only like every arm before it:

```ts
| { readonly kind: "participant-handicap-set"; readonly golferId: GolferId; readonly courseHandicap: number }
```

`golferId` is the SUBJECT (whose handicap); `authorId` (the envelope) is who recorded it —
the same subject/author split as `score-recorded` and `participant-left`. The event carries
**only** the handicap.

**Fold rule (`reduceRound`, participants register):** a golfer's effective seat
`courseHandicap` is the HLC-latest among their joins' `participant.courseHandicap` and their
`participant-handicap-set` events. Concretely: track the latest set per golfer
(HLC-compared, like `leavesByGolfer`); when materializing the roster, the set's value
replaces the seat's CH **iff** the set's hlc is strictly later than that golfer's
`latestJoinHlc`. Everything about this is order-independent over arrival (pure HLC
comparison), deduped by opId like every event, and:

- **Presence is untouched.** `departed` still resolves from {join, leave} only. Correcting
  a departed player's CH updates the number and never re-seats them — a real case, since a
  player who left after 12 holes still counts in every game and their mis-struck holes
  deserve the fix.
- **A genuine rejoin still wins.** A later `participant-joined` (rejoin after leave, with a
  fresh CH typed into the join form) has a later hlc than any prior set, so the join's CH
  applies.
- **A set for a golfer with no folded join contributes nothing** (no seat exists), exactly
  like a leave-before-join — it waits harmlessly, keeping the fold commutative.
- **Name-freeze holds by construction.** The event structurally cannot carry a name or tee,
  so a correction can never rewrite a card name. Illegal states unrepresentable.

**Rejected — reusing `participant-joined` (the design's own first draft, owner-probed):**
the fold's LWW seat map would absorb a second join for free, but `participant-joined` is a
*presence* fact — a later join clears `departed` (that's what makes rejoin work). Emitting
one to fix a number asserts something that didn't happen and drags presence along with it
(correcting a departed player would silently re-seat them, which forced a
"no-corrections-for-departed" guard into the draft). Needing a guard to suppress half an
event's meaning is the sign it's the wrong event. The dedicated event deletes the guard
instead of accepting it.

**Rejected — a client-authored offline event** (new `RoundSession` method + relaxing the
transport's score-recorded-only narrowing): scoring is the only offline-first write in v1 by
design; every roster/setup mutation (join, leave, add game, terminate) is a REST command. A
once-a-round correction doesn't justify breaking the "clients author only `score-recorded`"
invariant. If you're offline you can't add a game either — same class, same answer.

## 4. The wire

**Route:** `POST /rounds/{roundId}/handicap` — auth `participant`, success 200. Route counts
37→38 HTTP (40 total). NOT in the anonymous throttle set (participant-authed).

**Request** (`contracts/commands.ts`):

```ts
export const setHandicapRequestSchema = z.object({
  golferId: golferIdSchema,
  courseHandicap: z.number().int(), // may be negative (plus handicap)
});
```

**Response:** the append idiom (`terminateGame`/`leaveRound` precedent) —
`{ events: readonly RoundEvent[] }` carrying exactly what this call appended, seq-stamped.

**Use case** (`application/rounds/setHandicap.ts`), shaped like `leaveRound`:
`requireParticipant(state, claims.golferId)` (author) and
`requireParticipant(state, request.golferId)` (subject — a departed golfer still holds a
seat, so still correctable), `round-not-live` on any non-live round, then append ONE
`participant-handicap-set` with a server-minted envelope (`serverEnvelope`, authorId = the
caller) and broadcast it. **Authority: any participant may correct any participant** — the
score-for-anyone trust model; the card is shared and a wrong CH is a card error whoever's
holding the phone can fix.

**Errors:** existing vocabulary only — `not-a-participant` (403, author or subject),
`round-not-live` (409). No new codes, no `errorMapping` change.

**Contracts event arm** (`contracts/round.ts`, mirrors the domain):

```ts
z.object({ ...envelope, kind: z.literal("participant-handicap-set"), golferId: golferIdSchema, courseHandicap: z.number().int() }),
```

## 5. The surface — the roster row is the editor

In `SetupPanel`'s roster, each participant's row gains an **Edit** affordance next to
`CH {formatCourseHandicap(...)}`. Tapping it swaps in a small inline editor:

- A numeric input holding the raw signed integer (the same convention as the tee-time
  strokes field; the plus-handicap grep gate's editable-`<input>` carve-out covers it).
- One teaching line, verbatim: **"Strokes apply to the whole round — dots and games update
  everywhere."** No modal, no confirmation ceremony — the note states the consequence, and
  the dots visibly moving is the feedback.
- Save / Cancel. Save calls the new `api.setHandicap(roundId, token, { golferId,
  courseHandicap })`, then `await sync()` (the established post-then-let-the-fold-render
  pattern every RoundPage mutation uses). No optimistic local write.

Wired as a new `SetupPanel` prop `onSetHandicap(golferId, courseHandicap)` implemented in
`RoundPage`, exactly like `onAddGame`. The editor exists only where `SetupPanel` renders
(the live round); the server's `round-not-live` guard is the authority.

**Scope: CH only.** The mechanism could carry a tee correction later (another field or a
sibling event), but the field complaint is CH — tee correction is recorded as a follow-on,
not built now.

## 6. What doesn't change (and what falls out free)

- **Domain compute:** `courseHandicapAllocation`, `gameStrokeAllocation`, engines, AGS —
  untouched. They already read the folded roster; the correction propagates by construction.
- **Settle/archive/record:** `settleRound` archives the fold's roster verbatim, so the
  archive and `GolferRoundLine.courseHandicap` carry the corrected value with zero changes.
- **Watch:** renders the same live fold — corrections appear for spectators free.
- **Client transport:** the push guard (`score-recorded` only) is unchanged; this event is
  server-minted and reaches clients via pull/WS like every roster event.
- **The card's identity line:** roster rows still render name — tee — CH through
  `formatCourseHandicap`; a corrected plus handicap renders `CH +2` like any other.

## 7. Deploy

Additive event + additive route: **lambda-first**, then `publishWeb`. Stale-bundle window:
an old bundle that pulls a log containing the new event kind fails the discriminated-union
parse until refresh — the exact window accepted for the cleared-score arm, and it only opens
once someone in the round has used the new editor (which requires the new bundle). No data
change, no wipe, no migration.

## 8. Testing & gates

- **Domain:** fold tests — set overrides join CH; latest of multiple sets wins; rejoin later
  than a set wins; set earlier than latest join loses; set on a departed golfer updates CH
  and does NOT clear `departed`; set with no join contributes nothing; commutative under
  permutation (the state.properties suite's idiom); opId dedup. Settle test — archive
  participants carry the corrected CH.
- **Contracts:** wire arm round-trips; parity check covers the new arm.
- **Application:** appends the event (subject + value + server envelope); author-not-seated
  and subject-not-seated → `not-a-participant`; non-live round → `round-not-live`; departed
  subject succeeds.
- **Lambda/infra:** route dispatches with participant auth; `HTTP_ROUTES` gains the entry
  (stage `DependsOn` and count pins follow from the list itself).
- **Web:** SetupPanel editor component tests (opens, submits the parsed signed integer,
  renders the teaching line, cancel restores the row); the plus-handicap grep gate still
  passes whole-tree.
- **e2e:** one wire-level case in the root suite (`roundSlice.e2e.test.ts`): correct a CH
  after scoring, events reflect it, archive reflects it. One browser spec
  (`apps/web/e2e/handicapCorrection.spec.ts`) doing the thing the field report couldn't:
  two accounts, score holes, correct a CH mid-round from the roster, assert dots move on an
  already-scored hole and a game standing changes, finalize, corrected CH in the archive.
- `pnpm validate` green at every commit; close-out is the standard controller-run gate
  (deploy lambda-first → publish web → e2e:beta → e2e:field → live walk on beta.swng.golf).
