import { findTeeSet, type Hole } from "../course/card.js";
import { DomainError } from "../errors.js";
import type { GolferId } from "../ids.js";
import { intendedHoles } from "../round/holes.js";
import { cellAt } from "../round/state.js";
import type { RoundState } from "../round/state.js";

export interface PlayerTeeSet {
  // The holes THIS ROUND set out to play, off this player's own tee (spec 2026-08-02 §3c). Every
  // engine walks this, never a raw tee set's own `.holes` — the tee set describes the course, this
  // describes the round. Resolved once per player rather than per hole.
  //
  // `participant` and the tee set itself were dropped (task-3 review finding): all five engines
  // destructure only `holes`, `participant` had no consumer even before this arc, and leaving the
  // tee set here would keep a `teeSet.holes` walk one keystroke away from the exact regression
  // this arc closes. Add a field back only when something actually reads it.
  readonly holes: readonly Hole[];
}

export const playerTeeSet = (state: RoundState, golferId: GolferId): PlayerTeeSet => {
  const participant = state.participants.find((p) => p.golferId === golferId);
  if (!participant) throw new DomainError("unknown-participant", `no participant ${golferId} joined this round`);
  const teeSet = findTeeSet(state.card, participant.tee);
  return { holes: intendedHoles(teeSet, state.holes) };
};

// True once every player has a recorded cell for every hole the ROUND set out to play — the shared
// "nothing left pending" predicate behind each per-player engine's `complete`.
export const allPlayersComplete = (state: RoundState, players: readonly GolferId[]): boolean =>
  players.every((golferId) => {
    const participant = state.participants.find((p) => p.golferId === golferId);
    if (!participant) return false;
    const holes = intendedHoles(findTeeSet(state.card, participant.tee), state.holes);
    return holes.every((hole) => cellAt(state.cells, golferId, hole.number) !== undefined);
  });
