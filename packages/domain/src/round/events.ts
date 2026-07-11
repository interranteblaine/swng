import type { CrewId, GameId, GolferId, OpId, RoundId } from "../ids.js";
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
    // crewId is optional: a round is a crew round via this tag at creation
    // (architecture.md's Crew section), stamped once and never revised — a round doesn't
    // move between crews after the fact.
    | { readonly kind: "round-created"; readonly roundId: RoundId; readonly card: CourseCard; readonly crewId?: CrewId }
    | { readonly kind: "participant-joined"; readonly participant: Participant }
    | { readonly kind: "game-added"; readonly config: GameConfig }
    | { readonly kind: "round-started" }
    | { readonly kind: "score-recorded"; readonly golferId: GolferId; readonly hole: number; readonly result: HoleResult }
    | { readonly kind: "round-finalized" }
    | { readonly kind: "round-reopened" }
    | { readonly kind: "game-terminated"; readonly gameId: GameId }
  );
