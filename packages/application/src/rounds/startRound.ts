import type { GolferId, Participant, RoundEvent } from "@swng/domain";
import { findTeeSet, golferId, roundId } from "@swng/domain";
import type { StartRoundRequest, StartRoundResponse } from "@swng/contracts";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { RoundStore } from "../ports/roundStore.js";
import type { TokenIssuer } from "../ports/tokenIssuer.js";
import { serverEnvelope } from "./serverEnvelope.js";

// Rounds are live from creation (M3 plan): no go-live command in v1, so the one append a
// round is born with is already the full setup-to-live transition — genesis, the host's
// own join, and start, in that fixed order.
export const startRound =
  (deps: { journal: EventJournal; store: RoundStore; broadcast: Broadcast; tokens: TokenIssuer; clock: Clock; ids: IdGenerator }) =>
  async (command: StartRoundRequest): Promise<StartRoundResponse> => {
    findTeeSet(command.card, command.host.tee); // unknown-tee-set (DomainError) propagates

    const id = roundId(deps.ids.newId());
    const host: GolferId = golferId(deps.ids.newId());
    const joinCode = deps.ids.newJoinCode();

    const hostParticipant: Participant = { golferId: host, name: command.host.name, tee: command.host.tee, courseHandicap: command.host.courseHandicap };

    const events: readonly RoundEvent[] = [
      { kind: "round-created", roundId: id, card: command.card, ...serverEnvelope(deps, host) },
      { kind: "participant-joined", participant: hostParticipant, ...serverEnvelope(deps, host) },
      { kind: "round-started", ...serverEnvelope(deps, host) },
    ];

    await deps.store.createRound({ roundId: id, joinCode });
    const result = await deps.journal.append(id, events);
    await deps.broadcast.publish(id, result.appended);

    const token = deps.tokens.issue({ roundId: id, golferId: host });

    return { roundId: id, joinCode, token, golferId: host };
  };
