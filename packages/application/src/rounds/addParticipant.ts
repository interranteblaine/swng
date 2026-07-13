import type { GolferId, Participant } from "@swng/domain";
import { findTeeSet, golferId } from "@swng/domain";
import type { AddParticipantRequest, AddParticipantResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { Logger } from "../ports/logger.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import type { ParticipantClaims } from "../ports/tokenIssuer.js";
import { requireParticipant } from "../scoringPolicy.js";
import { resolveSuppliedGolfer } from "./golferIdentity.js";
import { loadRoundState } from "./loadRoundState.js";
import { writePresence } from "./presence.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

// POST /rounds/{roundId}/players (participant auth, M8 plan): an ALREADY-seated participant
// adds someone else to the roster — the crew one-tap flow's mid-round/mid-setup counterpart
// to StartRound's own `players` array (for a crew member who wasn't there at creation time).
// Any participant may add another, same "any participant may X" authorization as addGame/
// terminateGame — no extra gate beyond requireParticipant.
//
// A participant TOKEN never carries a Cognito sub (tokenIssuer.ts: "GolferId is deliberately
// not the Cognito sub... a participant token is issued off a join code, no account
// required"), so the shared resolver's ctx here always passes sub: undefined. That disables
// BOTH sub-gated arms through this surface: as-self AND co-membership consent (which now
// derives the caller's crews from their sub — golferIdentity.ts). Only the unclaimed arm and
// the claimed-stranger rejection are reachable here; seating a CLAIMED fellow crew member
// happens on startRound/joinRound instead, which do carry an optional AccountClaims. This is a
// deliberate narrowing under round-is-a-sealed-leaf: the round no longer names a crew, so a
// bare participant token can't stand in for proof of who the caller is.
export const addParticipant =
  (deps: {
    journal: EventJournal;
    broadcast: Broadcast;
    clock: Clock;
    ids: IdGenerator;
    golferStore: GolferStore;
    crewStore: CrewStore;
    projectionStore: ProjectionStore;
    logger: Logger;
  }) =>
  async (claims: ParticipantClaims, command: AddParticipantRequest): Promise<AddParticipantResponse> => {
    const { state } = await loadRoundState(deps.journal, claims.roundId);
    requireParticipant(state, claims.golferId);
    if (state.status === "final") throw new ApplicationError("round-final");
    findTeeSet(state.card, command.tee); // unknown-tee-set (DomainError) propagates

    let golfer: GolferId;
    if (command.golferId !== undefined) {
      golfer = await resolveSuppliedGolfer({ golferStore: deps.golferStore, crewStore: deps.crewStore })(command.golferId, {
        sub: undefined,
      });
      // UX guard, same as joinRound's own: a duplicate participant-joined is harmless at the
      // domain layer (last-write-wins on golferId) but rejected here to avoid surprising the
      // roster with a silent no-op change.
      if (state.participants.some((participant) => participant.golferId === command.golferId)) {
        throw new ApplicationError("golfer-already-in-round", `golfer ${command.golferId} is already a participant in this round`);
      }
    } else {
      golfer = golferId(deps.ids.newId());
    }

    const participant: Participant = { golferId: golfer, name: command.name, tee: command.tee, courseHandicap: command.courseHandicap };

    const hlc = createServerHlcSource(deps.clock);
    const result = await deps.journal.append(claims.roundId, [
      { kind: "participant-joined", participant, ...serverEnvelope({ hlc, ids: deps.ids }, claims.golferId) },
    ]);
    await deps.broadcast.publish(claims.roundId, result.appended);

    // Presence (spec §5, Task 13): the added player's own LIVE pointer, written only after the
    // add has actually committed above — best-effort, never undoes the add (presence.ts).
    await writePresence({ projectionStore: deps.projectionStore, logger: deps.logger, clock: deps.clock }, golfer, claims.roundId, state.card.courseName);

    return { events: result.appended };
  };
