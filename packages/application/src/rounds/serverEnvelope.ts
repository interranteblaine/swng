import type { GolferId, Hlc, OpId } from "@swng/domain";
import { deviceId, opId } from "@swng/domain";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/idGenerator.js";

// A monotonic source of server hlcs, anchored to the server Clock: same-millisecond stamps
// within one source's lifetime get strictly increasing counters instead of colliding on
// counter 0. compareHlc (domain/round/hlc.ts) orders by (wallMs, counter, deviceId), and the
// fold's status/roster/game registers resolve ties by taking the LAST event in that
// canonical order — so a batch of server events minted in the same millisecond (StartRound's
// round-created + participant-joined + round-started) needs strictly increasing (wallMs,
// counter) to keep its authored order, not a coin flip on opId. Scoped per use-case
// invocation (each async function below builds one via createServerHlcSource(deps.clock)
// and threads it through every serverEnvelope call in that invocation) — same clock, same
// source, so a single request's batch is internally ordered without any cross-request state.
export interface ServerHlcSource {
  next(): Hlc;
}

export const createServerHlcSource = (clock: Clock): ServerHlcSource => {
  let lastWallMs: number | undefined;
  let counter = 0;
  return {
    next: (): Hlc => {
      const wallMs = clock.now();
      counter = wallMs === lastWallMs ? counter + 1 : 0;
      lastWallMs = wallMs;
      return { wallMs, counter, deviceId: deviceId("server") };
    },
  };
};

// Every server-authored event (round-created, participant-joined, game-added,
// round-started, round-finalized) stamps its envelope identically: a fresh server-minted
// opId, an hlc drawn from the invocation's ServerHlcSource with deviceId "server", and the
// commanding golfer as author (M3 plan, Global Constraints). Pulled into one helper so the
// four call sites can't drift on this shape (conventions §0) — score-recorded is the one
// event kind that never goes through here, since its envelope is client-authored.
export const serverEnvelope = (deps: { hlc: ServerHlcSource; ids: IdGenerator }, authorId: GolferId): { opId: OpId; hlc: Hlc; authorId: GolferId } => ({
  opId: opId(deps.ids.newId()),
  hlc: deps.hlc.next(),
  authorId,
});
