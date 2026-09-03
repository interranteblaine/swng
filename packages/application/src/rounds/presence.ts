import type { GolferId, RoundId } from "@swng/domain";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { ProjectionStore } from "../ports/projectionStore.js";

// Presence (projection-realignment spec §5, Task 13): one LIVE#<roundId> pointer under the
// seated golfer's OWN identity partition — written at seat-time by both seat paths (startRound
// for the creator, joinRound for the as-self joiner), so "your rounds" (the signed-in home
// screen, getMyLiveRounds.ts) can find a live round by WHO is playing it, not by which device
// happens to hold a scoring token for it. Every seated golfer is an account now (accounts-only
// identity spec §3), so this is always written under a real account golfer's identity.
//
// Best-effort BY DESIGN (spec §5's own binding resolution): a discovery nicety must never
// block the round actually starting/being joined, which — by the time this is called — has
// already committed to the journal. Swallow-and-log, never rethrow.
export const writePresence = async (
  deps: { readonly projectionStore: ProjectionStore; readonly logger: Logger; readonly clock: Clock },
  golferId: GolferId,
  roundId: RoundId,
  courseName: string,
): Promise<void> => {
  try {
    // No expiry, by construction (ports/projectionStore.ts): the pointer is removed when the
    // ROUND ends — finalize or abandon — and by nothing else. `joinedAtMs` is a display/sort
    // fact only; nothing reads it as a deadline.
    await deps.projectionStore.putLive(golferId, { roundId, courseName, joinedAtMs: deps.clock.now() });
  } catch (error) {
    deps.logger.warn("presence-write-failed", {
      golferId,
      roundId,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
};
