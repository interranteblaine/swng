import type { GameId, GolferId, OpId, RoundId } from "../ids.js";
import type { CourseCard } from "../course/card.js";
import type { GameConfig } from "../scoring/game.js";
import type { StrokeBasis } from "../scoring/strokeBasis.js";
import type { Hlc } from "./hlc.js";
import type { Participant } from "./participant.js";
import type { HoleResult } from "./holeResult.js";

export type { GameConfig };

// seq is server-assigned canonical order (absent until acked); the fold never uses it —
// conflicts resolve by hlc so offline replays can't clobber later intent.
export interface RoundEventBase {
  readonly opId: OpId;
  readonly hlc: Hlc;
  readonly authorId: GolferId;
  readonly seq?: number;
}

export type RoundEvent = RoundEventBase &
  (
    // A round is a sealed leaf: round-created names ONLY the round's own facts (its id and
    // frozen card), never an outbound crew reference. Crews reference rounds inbound instead
    // (a crew counts a finished round by roundId into one of its seasons — CrewStore's counted
    // rounds), so nothing in the round log points back at a crew. Old stored logs whose genesis
    // still carries a stray `crewId` JSON key keep parsing and folding (the wire schema strips
    // it, the fold ignores it) — the event log is append-only, so we tolerate the extra key,
    // never reject the data.
    | { readonly kind: "round-created"; readonly roundId: RoundId; readonly card: CourseCard }
    | { readonly kind: "participant-joined"; readonly participant: Participant }
    | { readonly kind: "game-added"; readonly config: GameConfig }
    | { readonly kind: "round-started" }
    | { readonly kind: "score-recorded"; readonly golferId: GolferId; readonly hole: number; readonly result: HoleResult }
    | { readonly kind: "round-finalized" }
    | { readonly kind: "round-reopened" }
    // A round scrapped for good (task-15): a terminal, envelope-only lifecycle event mirroring
    // round-finalized's shape exactly. Distinct from round-finalized in the fold, though — an
    // abandon has NO inverse (there is no un-abandon the way round-reopened un-finalizes), so it
    // is DOMINANT and terminal in reduceRound (state.ts), and settleRound (archive.ts) produces
    // NO snapshot for it: a scrapped round counts nowhere.
    | { readonly kind: "round-abandoned" }
    | { readonly kind: "game-terminated"; readonly gameId: GameId }
    // A participant walks off (accounts-only identity spec §4): an ordinary round event with
    // NO preconditions in the fold — no referenced-by-a-game gate, no dominance rules beyond
    // the existing terminal-event law. `golferId` names who left (the SUBJECT); `authorId`
    // (the envelope) is who recorded it — the domain does not enforce self-authorship, the API
    // layer does. Presence is resolved by HLC in reduceRound (state.ts): for each golferId the
    // latest of {participant-joined, participant-left} wins. Additive/append-only, like every
    // event kind before it — an old client that never sends it is unaffected.
    | { readonly kind: "participant-left"; readonly golferId: GolferId }
    // Mid-round correction of what a player stated about themselves (spec 2026-07-20, re-shaped
    // by 2026-07-29 §2a): a NARROW, dedicated event — deliberately NOT a second
    // participant-joined, which is a presence fact (a later join clears `departed`; that's what
    // makes rejoin work) and carries the whole seat. This arm carries ONLY the assertion, so a
    // correction structurally cannot rewrite a card name or tee and never touches presence.
    // `golferId` is the SUBJECT (whose basis); `authorId` (the envelope) is who recorded it —
    // the score-recorded split; any participant may correct any participant (the
    // score-for-anyone trust model), enforced at the API layer, not here.
    //
    // NOT additive, unlike every arm above it: this arm was `participant-handicap-set` carrying
    // an integer `courseHandicap`, and any ALREADY-STORED event of that shape is unparseable
    // against the wire schema now (contracts/round.ts's roundEventSchema backs six
    // `events[]`-carrying response schemas; client/src/transport.ts parses every pulled event).
    // Accepted deliberately: beta's round data and snapshots are wiped at this arc's close-out,
    // and there is nothing honest to migrate — a stored integer is semantically AMBIGUOUS under
    // the relative model (some were absolute course handicaps, some were already differences the
    // group typed by hand), which is the spec's own §8 argument for the wipe. No tolerate-old-
    // shape branch, no `.default()`, no migration. THE DEPLOY IS LAMBDA-FIRST: a stale bundle
    // posting the old integer body gets a 400 until it refreshes, whereas web-first would have a
    // new bundle's `basis` object silently stripped by the old lambda's non-strict parse and a
    // meaningless event written into a sealed log — the same class of mistake a non-additive
    // stored-schema change always risks (task-1's `conceded` arm deletion carried the identical
    // deploy-order argument, on the theory that beta's data is wiped rather than migrated).
    | { readonly kind: "participant-basis-set"; readonly golferId: GolferId; readonly basis: StrokeBasis }
  );
