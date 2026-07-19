import { findTeeSet, type TeeSet } from "../course/card.js";
import { DomainError } from "../errors.js";
import type { GolferId } from "../ids.js";
import type { Participant } from "../round/participant.js";
import { cellAt } from "../round/state.js";
import type { RoundState } from "../round/state.js";

export interface PlayerTeeSet {
  readonly participant: Participant;
  readonly teeSet: TeeSet;
}

// Resolves a golfer's participant record and their tee's hole/par/strokeIndex data —
// looked up once per player rather than per hole, since both are invariant across the round.
export const playerTeeSet = (state: RoundState, golferId: GolferId): PlayerTeeSet => {
  const participant = state.participants.find((p) => p.golferId === golferId);
  if (!participant) throw new DomainError("unknown-participant", `no participant ${golferId} joined this round`);
  const teeSet = findTeeSet(state.card, participant.tee);
  return { participant, teeSet };
};

// True once every player has a recorded cell for every hole on their own tee set —
// the shared "nothing left pending" predicate behind each per-player engine's `complete`.
export const allPlayersComplete = (state: RoundState, players: readonly GolferId[]): boolean =>
  players.every((golferId) => {
    const participant = state.participants.find((p) => p.golferId === golferId);
    if (!participant) return false;
    const teeSet = findTeeSet(state.card, participant.tee);
    return teeSet.holes.every((hole) => cellAt(state.cells, golferId, hole.number) !== undefined);
  });
