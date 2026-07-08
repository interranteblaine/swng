import type { GolferId, Hlc, OpId } from "@swng/domain";
import { deviceId, opId } from "@swng/domain";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/idGenerator.js";

// Every server-authored event (round-created, participant-joined, game-added,
// round-started, round-finalized) stamps its envelope identically: a fresh server-minted
// opId, an hlc anchored to the server clock with deviceId "server", and the commanding
// golfer as author (M3 plan, Global Constraints). Pulled into one helper so the four call
// sites can't drift on this shape (conventions §0) — score-recorded is the one event kind
// that never goes through here, since its envelope is client-authored.
export const serverEnvelope = (deps: { clock: Clock; ids: IdGenerator }, authorId: GolferId): { opId: OpId; hlc: Hlc; authorId: GolferId } => ({
  opId: opId(deps.ids.newId()),
  hlc: { wallMs: deps.clock.now(), counter: 0, deviceId: deviceId("server") },
  authorId,
});
