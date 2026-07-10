import type { GolferId, Participant } from "@swng/domain";
import { findTeeSet, golferId } from "@swng/domain";
import type { JoinRoundRequest, JoinRoundResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { RoundStore } from "../ports/roundStore.js";
import type { TokenIssuer } from "../ports/tokenIssuer.js";
import { loadRoundState } from "./loadRoundState.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

export const joinRound =
  (deps: { journal: EventJournal; store: RoundStore; broadcast: Broadcast; tokens: TokenIssuer; clock: Clock; ids: IdGenerator; golferStore: GolferStore }) =>
  async (command: JoinRoundRequest): Promise<JoinRoundResponse> => {
    const id = await deps.store.findByJoinCode(command.code);
    if (!id) throw new ApplicationError("bad-join-code");

    const { state } = await loadRoundState(deps.journal, id);
    if (state.status === "final") throw new ApplicationError("round-final");
    findTeeSet(state.card, command.tee); // unknown-tee-set (DomainError) propagates

    // Task 5b (ghost continuity): a supplied golferId is reused as-is IFF unclaimed — absence
    // of a GOLFER row means unclaimed (rows are lazy — a ghost from another round has no row
    // at all), only a row WITH a sub blocks reuse. When absent, behavior is byte-identical to
    // before this task: mint a fresh id.
    let golfer: GolferId;
    if (command.golferId !== undefined) {
      const existing = await deps.golferStore.get(command.golferId);
      if (existing?.sub !== undefined) throw new ApplicationError("golfer-claimed", `golfer ${command.golferId} is claimed`);
      if (state.participants.some((participant) => participant.golferId === command.golferId)) {
        throw new ApplicationError("golfer-already-in-round", `golfer ${command.golferId} is already a participant in this round`);
      }
      golfer = command.golferId;
    } else {
      golfer = golferId(deps.ids.newId());
    }

    const participant: Participant = { golferId: golfer, name: command.name, tee: command.tee, courseHandicap: command.courseHandicap };

    const hlc = createServerHlcSource(deps.clock);
    const result = await deps.journal.append(id, [{ kind: "participant-joined", participant, ...serverEnvelope({ hlc, ids: deps.ids }, golfer) }]);
    await deps.broadcast.publish(id, result.appended);

    const token = deps.tokens.issue({ roundId: id, golferId: golfer });

    return { roundId: id, token, golferId: golfer };
  };
