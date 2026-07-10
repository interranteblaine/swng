import type { GameId } from "@swng/domain";
import type { TerminateGameResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { ParticipantClaims } from "../ports/tokenIssuer.js";
import { requireParticipant } from "../scoringPolicy.js";
import { loadRoundState } from "./loadRoundState.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

// Any participant may terminate a game (matches the finalize rule, M7 plan) — no extra
// authorization beyond requireParticipant. Game management is a connected, online act (not
// an offline outbox op like score-recorded), so this is a plain HTTP command like
// addGame/finalize, server-envelope-stamped the same way.
export const terminateGame =
  (deps: { journal: EventJournal; broadcast: Broadcast; clock: Clock; ids: IdGenerator }) =>
  async (claims: ParticipantClaims, targetGameId: GameId): Promise<TerminateGameResponse> => {
    const { state } = await loadRoundState(deps.journal, claims.roundId);
    requireParticipant(state, claims.golferId);
    if (state.status !== "live") throw new ApplicationError("round-not-live");

    // Idempotent no-op (matches the opId-dedupe spirit, M7 plan): terminating an
    // already-terminated game appends nothing and returns the empty tail. Checked BEFORE
    // the unknown-game guard on purpose — domain's terminatedGameIds fold is independent of
    // `games` (state.ts: a termination can land before its game-added), so a repeat
    // terminate on an id that's terminated-but-not-yet-in-`games` is still a legitimate
    // no-op, not an unknown-game error.
    if (state.terminatedGameIds.has(targetGameId)) return { events: [] };

    if (!state.games.some((game) => game.id === targetGameId)) throw new ApplicationError("unknown-game");

    const hlc = createServerHlcSource(deps.clock);
    const result = await deps.journal.append(claims.roundId, [
      { kind: "game-terminated", gameId: targetGameId, ...serverEnvelope({ hlc, ids: deps.ids }, claims.golferId) },
    ]);
    await deps.broadcast.publish(claims.roundId, result.appended);
    return { events: result.appended };
  };
