import type { GameId, GolferId, OpId, RoundId } from "../ids.js";
import type { CourseCard } from "../course/card.js";
import type { GameConfig } from "../scoring/game.js";
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
  );
