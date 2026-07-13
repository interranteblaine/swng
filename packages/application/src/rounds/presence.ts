import type { GolferId, RoundId } from "@swng/domain";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { ProjectionStore } from "../ports/projectionStore.js";

// TTL backstop (spec §5, ports/projectionStore.ts's own doc comment): 36 hours comfortably
// outlives any real round (even an 18-hole round with a long lunch break) but still reclaims
// a pointer a round that never gets finalized (abandoned mid-setup, a device lost) would
// otherwise leave live forever. The PRIMARY removal path is projections/projectArchive.ts's
// own deleteLive loop at finalize time — this is only what fires if that never happens.
const PRESENCE_TTL_SECONDS = 36 * 3_600;

// Presence (projection-realignment spec §5, Task 13): one LIVE#<roundId> pointer under the
// seated golfer's OWN identity partition — written at seat-time by every caller that puts a
// participant-joined event on the log (startRound for the host + every `players[]` entry,
// joinRound for the joiner, addParticipant for the added player), so "your rounds" (the
// signed-in home screen, getMyLiveRounds.ts) can find a live round by WHO is playing it, not
// by which device happens to hold a scoring token for it. Ghosts get this for free — a later
// claim inherits whatever presence already exists under that GolferId, no special-casing.
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
    // One clock read shared between joinedAtMs and expiresAtSec — not two separate `now()`
    // calls — so the two never drift relative to each other under a test clock that advances
    // per call (testing/fakes.ts's createFixedClock).
    const nowMs = deps.clock.now();
    await deps.projectionStore.putLive(golferId, {
      roundId,
      courseName,
      joinedAtMs: nowMs,
      expiresAtSec: Math.floor(nowMs / 1_000) + PRESENCE_TTL_SECONDS,
    });
  } catch (error) {
    deps.logger.warn("presence-write-failed", {
      golferId,
      roundId,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
};
