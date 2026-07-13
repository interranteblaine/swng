import type { GolferId, Participant, RoundEvent } from "@swng/domain";
import { findTeeSet, golferId, roundId } from "@swng/domain";
import type { StartRoundRequest, StartRoundResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { Logger } from "../ports/logger.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import type { RoundStore } from "../ports/roundStore.js";
import type { TokenIssuer } from "../ports/tokenIssuer.js";
import { resolveSuppliedGolfer } from "./golferIdentity.js";
import { writePresence } from "./presence.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

// Rounds are live from creation (M3 plan): no go-live command in v1, so the one append a
// round is born with is already the full setup-to-live transition — genesis, the host's
// own join, every extra `players` roster entry (M8, in request order), and start, in that
// fixed order.
export const startRound =
  (deps: {
    journal: EventJournal;
    store: RoundStore;
    broadcast: Broadcast;
    tokens: TokenIssuer;
    clock: Clock;
    ids: IdGenerator;
    golferStore: GolferStore;
    crewStore: CrewStore;
    projectionStore: ProjectionStore;
    logger: Logger;
  }) =>
  // claims is optional: starting a round has never required an account (M3's whole point —
  // no account needed to play). It's threaded through so the M8 as-self/crew fields can be
  // authorized when a caller DOES present one; an anonymous start with none of the M8 fields
  // set behaves byte-identically to before this parameter existed.
  async (command: StartRoundRequest, claims?: AccountClaims): Promise<StartRoundResponse> => {
    findTeeSet(command.card, command.host.tee); // unknown-tee-set (DomainError) propagates
    for (const player of command.players ?? []) findTeeSet(command.card, player.tee);

    // M9 hardening (papercut 1): a request naming the SAME golferId twice — either two
    // players[] entries, or a player matching the host's own supplied golferId — would resolve
    // to one GolferId doing double duty as two roster seats. Checked before anything is
    // minted/written (same "reject before touching state" discipline as the tee-set checks
    // above); an unsupplied (mint-fresh) golferId never collides with anything, so only
    // explicitly-supplied ids are compared. Reuses joinRound's own "already a participant" code
    // (golfer-already-in-round) — same shape, one golferId can't hold two seats.
    const suppliedGolferIds = [command.golferId, ...(command.players ?? []).map((player) => player.golferId)].filter(
      (candidate): candidate is GolferId => candidate !== undefined,
    );
    if (new Set(suppliedGolferIds).size !== suppliedGolferIds.length) {
      throw new ApplicationError("golfer-already-in-round");
    }

    // Round-is-a-sealed-leaf: a round no longer tags itself with a crew, so there's no crew
    // membership to check at creation. A signed-in caller may still seat a claimed fellow crew
    // member — that consent now flows from co-membership inside the shared resolver (it derives
    // the caller's own crews from claims.sub), not from a tag on the round.
    const resolveGolfer = resolveSuppliedGolfer({ golferStore: deps.golferStore, crewStore: deps.crewStore });
    const identityCtx = { sub: claims?.sub };

    const id = roundId(deps.ids.newId());
    const host: GolferId = command.golferId !== undefined ? await resolveGolfer(command.golferId, identityCtx) : golferId(deps.ids.newId());
    const joinCode = deps.ids.newJoinCode();

    const hostParticipant: Participant = { golferId: host, name: command.host.name, tee: command.host.tee, courseHandicap: command.host.courseHandicap };

    // One hlc source for the whole batch: round-created, every participant-joined (the
    // host's own, then every M8 `players` entry in order), and start all stamp from the same
    // server clock in this single call, so without a shared monotonic source they could land
    // in the same millisecond and collide on hlc (see serverEnvelope.ts) — losing the fold's
    // canonical order and stranding the round in "setup" whenever round-created wins the
    // coin flip instead of round-started.
    const hlc = createServerHlcSource(deps.clock);
    const events: RoundEvent[] = [
      {
        kind: "round-created",
        roundId: id,
        card: command.card,
        ...serverEnvelope({ hlc, ids: deps.ids }, host),
      },
      { kind: "participant-joined", participant: hostParticipant, ...serverEnvelope({ hlc, ids: deps.ids }, host) },
    ];

    // Presence (spec §5, Task 13) is written for EVERY seated golfer — the host plus every
    // players[] entry — collected as they're resolved below rather than re-derived from
    // `events` afterward (participant-joined's own payload would work too, but this avoids a
    // second pass and a kind-narrowing filter for one array that's cheap to build inline).
    const seatedGolferIds: GolferId[] = [host];

    // Crew one-tap: seed the round with a whole roster in one call. Every player's optional
    // golferId goes through the SAME resolver as the host's, including its co-membership arm (a
    // signed-in host seating a claimed fellow crew member) — appended in request order, right
    // after the host, all authored by the host (this whole batch is the host's own setup act).
    for (const player of command.players ?? []) {
      const playerGolfer: GolferId = player.golferId !== undefined ? await resolveGolfer(player.golferId, identityCtx) : golferId(deps.ids.newId());
      const participant: Participant = { golferId: playerGolfer, name: player.name, tee: player.tee, courseHandicap: player.courseHandicap };
      events.push({ kind: "participant-joined", participant, ...serverEnvelope({ hlc, ids: deps.ids }, host) });
      seatedGolferIds.push(playerGolfer);
    }

    events.push({ kind: "round-started", ...serverEnvelope({ hlc, ids: deps.ids }, host) });

    // META (the join code) is written before the journal append, not after or alongside it
    // atomically — so a journal append that fails after this succeeds strands a join code
    // pointing at a round with an empty (or partial) log: joinRound's later read finds no
    // genesis event and 404s the joiner. Accepted for beta: no atomic cross-write exists
    // between the round store and the journal, and a stranded code just fails closed rather
    // than admitting anyone into a broken round. Deliberate, not an oversight.
    await deps.store.createRound({ roundId: id, joinCode });
    const result = await deps.journal.append(id, events);
    await deps.broadcast.publish(id, result.appended);

    // Presence (spec §5, Task 13): a LIVE pointer per seated golfer, written only after the
    // round has actually committed above — writePresence itself never throws (best-effort;
    // presence.ts's own doc comment), so this can't undo the seating that already happened.
    for (const seated of seatedGolferIds) {
      await writePresence({ projectionStore: deps.projectionStore, logger: deps.logger, clock: deps.clock }, seated, id, command.card.courseName);
    }

    const token = deps.tokens.issue({ scope: "participant", roundId: id, golferId: host });

    return { roundId: id, joinCode, token, golferId: host };
  };
