import type { GolferId, Participant, RoundEvent } from "@swng/domain";
import { findTeeSet, hasHoleChoice, roundId } from "@swng/domain";
import type { StartRoundRequest, StartRoundResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { CardStore } from "../ports/cardStore.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { Logger } from "../ports/logger.js";
import type { Metrics } from "../ports/metrics.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import type { RoundStore } from "../ports/roundStore.js";
import type { TokenIssuer } from "../ports/tokenIssuer.js";
import { ApplicationError } from "../errors.js";
import { ensureGolfer } from "../golfers/ensureGolfer.js";
import { writePresence } from "./presence.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

// Rounds are live from creation (M3 plan): no go-live command in v1, so the one append a
// round is born with is already the full setup-to-live transition — genesis, the creator's
// own join, and start, in that fixed order.
//
// Accounts-only identity (spec §3): StartRound seats its CREATOR ONLY, always as-self. The
// creator's golfer is resolved from the caller's Bearer through the ONE shared get-or-create
// (ensureGolfer) — a signed-in account with no golfer yet gets one minted right here. Nobody
// puts anyone else on a card: the ghost-seeding `players[]` path is gone, and the join link is
// the one way onto the round. The participant NAME frozen into the join event is the golfer
// record's name at start time (sealed leaf — a later profile rename never rewrites this card).
export const startRound =
  (deps: {
    journal: EventJournal;
    store: RoundStore;
    broadcast: Broadcast;
    tokens: TokenIssuer;
    clock: Clock;
    ids: IdGenerator;
    golferStore: GolferStore;
    projectionStore: ProjectionStore;
    logger: Logger;
    cardStore: CardStore;
    metrics?: Metrics;
  }) =>
  // claims is REQUIRED: POST /rounds is the "golfer" auth tier now (accounts-only identity spec
  // §3) — every person who appears in a round is a signed-in account, so there is no anonymous
  // start. The dispatcher guarantees a verified AccountClaims before this runs.
  async (command: StartRoundRequest, claims: AccountClaims): Promise<StartRoundResponse> => {
    // Course-cards spec §4: resolve the reference, insist on currency, freeze VERBATIM.
    const record = await deps.cardStore.getCurrent(command.course.courseId);
    if (!record) throw new ApplicationError("course-not-found");
    if (record.cardId !== command.course.cardId) {
      throw new ApplicationError("card-superseded", `course ${command.course.courseId}: current card is ${record.cardId}`);
    }
    const teeSet = findTeeSet(record.card, command.host.tee); // unknown-tee-set (DomainError) propagates

    // The one guard on this fact (spec 2026-08-02 §3): a nine selection needs a card that HAS two
    // nines. Checked here, at the one door where the card is already in hand, and never again —
    // intendedHoles is total, and a guard on a read path would make a stored round unreadable.
    // Reading the HOST'S TEE ALONE answers for the whole card: every tee on a card carries the
    // same hole count (domain's validateCard collapses every tee's hole count into one Set and
    // rejects a card whose tees disagree), so there is no other tee on this card whose hole count
    // could differ from teeSet's.
    const holes = command.holes ?? "all";
    if (holes !== "all" && !hasHoleChoice(teeSet)) {
      throw new ApplicationError("holes-not-on-this-card", `this course has one nine; "${holes}" names a second`);
    }

    // As-self, the ONLY identity path: get-or-create the caller's account golfer. The seat's
    // golferId and its frozen participant name both come straight from that record.
    const creator = await ensureGolfer({ golferStore: deps.golferStore, idGenerator: deps.ids, metrics: deps.metrics })(claims);
    const host: GolferId = creator.id;

    const id = roundId(deps.ids.newId());
    const joinCode = deps.ids.newJoinCode();

    // Strokes start at 0 (spec 2026-07-30 §2): nobody is asked what they shoot, and the group
    // types a number onto the roster when they settle it on the first tee.
    const hostParticipant: Participant = { golferId: host, name: creator.name, tee: command.host.tee, strokes: 0 };

    // One hlc source for the whole batch: round-created, the creator's participant-joined, and
    // round-started all stamp from the same server clock in this single call, so without a
    // shared monotonic source they could land in the same millisecond and collide on hlc (see
    // serverEnvelope.ts) — losing the fold's canonical order and stranding the round in "setup"
    // whenever round-created wins the coin flip instead of round-started.
    const hlc = createServerHlcSource(deps.clock);
    const events: RoundEvent[] = [
      {
        kind: "round-created",
        roundId: id,
        card: record.card,
        // playedAtMs (spec 2026-08-01 §3a/§4a): WHEN THE GOLF HAPPENED, not when this record was
        // created. Absent means now — exactly today's pre-arc behaviour — resolved from the SAME
        // server clock the hlc source above reads, so a round with no explicit playedAtMs still
        // agrees with its own envelope's wall time.
        playedAtMs: command.playedAtMs ?? deps.clock.now(),
        // Present only when it is not "all" (spec §3a) — absence is the default and keeps every
        // whole-card round's genesis byte-identical to the ones written before this existed.
        ...(holes !== "all" ? { holes } : {}),
        ...serverEnvelope({ hlc, ids: deps.ids }, host),
      },
      { kind: "participant-joined", participant: hostParticipant, ...serverEnvelope({ hlc, ids: deps.ids }, host) },
      { kind: "round-started", ...serverEnvelope({ hlc, ids: deps.ids }, host) },
    ];

    // META (the join code) is written before the journal append, not after or alongside it
    // atomically — so a journal append that fails after this succeeds strands a join code
    // pointing at a round with an empty (or partial) log: joinRound's later read finds no
    // genesis event and 404s the joiner. Accepted for beta: no atomic cross-write exists
    // between the round store and the journal, and a stranded code just fails closed rather
    // than admitting anyone into a broken round. Deliberate, not an oversight.
    await deps.store.createRound({ roundId: id, joinCode });
    const result = await deps.journal.append(id, events);
    await deps.broadcast.publish(id, result.appended);

    // Presence (spec §5, Task 13): a LIVE pointer for the seated creator, written only after the
    // round has actually committed above — writePresence itself never throws (best-effort;
    // presence.ts's own doc comment), so this can't undo the seating that already happened.
    await writePresence({ projectionStore: deps.projectionStore, logger: deps.logger, clock: deps.clock }, host, id, record.card.courseName);

    const token = deps.tokens.issue({ scope: "participant", roundId: id, golferId: host });

    deps.metrics?.count("RoundsCreated");
    return { roundId: id, joinCode, token, golferId: host };
  };
