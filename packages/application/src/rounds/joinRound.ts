import type { GolferId, Participant } from "@swng/domain";
import { findTeeSet } from "@swng/domain";
import type { JoinRoundRequest, JoinRoundResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { Logger } from "../ports/logger.js";
import type { Metrics } from "../ports/metrics.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import type { RoundStore } from "../ports/roundStore.js";
import type { TokenIssuer } from "../ports/tokenIssuer.js";
import { ensureGolfer } from "../golfers/ensureGolfer.js";
import { loadRoundState } from "./loadRoundState.js";
import { writePresence } from "./presence.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

// Accounts-only identity (spec §3): JoinRound is ALWAYS as-self. The joiner's golfer is resolved
// from the caller's Bearer through the ONE shared get-or-create (ensureGolfer) — a signed-in
// account with no golfer yet gets one minted right here. Nobody joins on anyone else's behalf,
// and there is no supplied golferId. The participant NAME frozen into the event is the golfer
// record's name at join time (sealed leaf — a later profile rename never rewrites this card).
export const joinRound =
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
    metrics?: Metrics;
  }) =>
  // claims is REQUIRED: POST /rounds/join is the "golfer" auth tier now (accounts-only identity
  // spec §3) — there is no anonymous join. The dispatcher guarantees a verified AccountClaims.
  async (command: JoinRoundRequest, claims: AccountClaims): Promise<JoinRoundResponse> => {
    const id = await deps.store.findByJoinCode(command.code);
    if (!id) throw new ApplicationError("bad-join-code");

    const { state } = await loadRoundState(deps.journal, id);
    if (state.status === "final") throw new ApplicationError("round-final");

    // As-self, the ONLY identity path: get-or-create the caller's account golfer. The seat's
    // golferId and its frozen participant name both come straight from that record.
    const golferRecord = await ensureGolfer({ golferStore: deps.golferStore, idGenerator: deps.ids, metrics: deps.metrics })(claims);
    const golfer: GolferId = golferRecord.id;

    // The seat this golfer already holds on this round, if any — either a still-seated re-tap
    // (answered immediately below) or a departed seat coming back.
    const seated = state.participants.find((participant) => participant.golferId === golfer);

    // Joining a round you are already in is IDEMPOTENT (2026-09-03 ticket): it hands back the
    // seat you already hold. This used to be a 409 — and the join code is the ONE thing every
    // golfer in a group has, which makes it the universal way back into a round when "Your
    // rounds" cannot show one. Refusing it turned the only door a stranded golfer had into a
    // dead end that told them, by uuid, that they could not go where they already were.
    //
    // The guard this replaces was aimed at the fold's last-write-wins on golferId silently
    // REWRITING the caller's seat. Honored exactly, and more strictly: this path appends
    // nothing. No participant-joined means no fold to win — the tee, the strokes and the seat
    // are untouched as a matter of structure rather than of care.
    //
    // `command.tee` is deliberately ignored here, and deliberately NOT validated (the
    // findTeeSet call moved below this branch for exactly that reason): the seat already has a
    // tee, this call cannot change it, so rejecting a stale or odd tee would fail a golfer's
    // way back in over a field this path does not read. Changing your tee is a different act
    // than getting back in, and it does not happen at this door.
    //
    // A DEPARTED golfer falls through — rejoining after leaving is just joining again (spec §4),
    // a real seat the fold must record, and their `departed` flag is cleared by that append.
    if (seated && seated.departed !== true) {
      // The pointer is repaired on the way through, on the same proof the seat itself rests on:
      // `seated` came from the round's own fold. So the code that gets a golfer back INTO the
      // round also puts it back in their list — one act, from the golfer's side.
      await writePresence({ projectionStore: deps.projectionStore, logger: deps.logger, clock: deps.clock }, golfer, id, state.card.courseName);
      return { roundId: id, token: deps.tokens.issue({ scope: "participant", roundId: id, golferId: golfer }), golferId: golfer, joinCode: command.code };
    }

    findTeeSet(state.card, command.tee); // unknown-tee-set (DomainError) propagates

    // A first join starts at 0 strokes (spec 2026-07-30 §2: joining asks no question about your
    // game); a REJOIN carries the seat's current number forward. That is not a nicety — the fold
    // seats the LATEST join's payload (round/state.ts step 4), so a rejoin writing a fresh 0 would
    // silently erase a number the group typed, retroactively across every dot, every standing and
    // the archive the finalize seals. Nothing re-asks for it at the door (the join body is
    // {code, tee}), so the event states what is true right now instead of asserting a 0 nobody
    // entered. Carrying it is the writer's job, deliberately, not the fold's: presence and strokes
    // stay orthogonal registers, and a later participant-strokes-set still wins.
    //
    // `state` was read at the top of this handler, so a participant-strokes-set that commits
    // between that read and this append loses to this join on HLC — a lost update bounded by one
    // request, plainly visible on the roster row and retypable. Conditioning this append on the
    // head seq instead would fail a legitimate join for any concurrent score, which is worse.
    const participant: Participant = { golferId: golfer, name: golferRecord.name, tee: command.tee, strokes: seated?.strokes ?? 0 };

    const hlc = createServerHlcSource(deps.clock);
    const result = await deps.journal.append(id, [{ kind: "participant-joined", participant, ...serverEnvelope({ hlc, ids: deps.ids }, golfer) }]);
    await deps.broadcast.publish(id, result.appended);

    // Presence (spec §5, Task 13): the joiner's own LIVE pointer, written only after the join
    // has actually committed above — best-effort, never undoes the join (presence.ts).
    await writePresence({ projectionStore: deps.projectionStore, logger: deps.logger, clock: deps.clock }, golfer, id, state.card.courseName);

    const token = deps.tokens.issue({ scope: "participant", roundId: id, golferId: golfer });

    // Echo, not a second read: findByJoinCode(command.code) just matched, so command.code IS
    // the canonical stored code (spec 2026-07-20 §2).
    return { roundId: id, token, golferId: golfer, joinCode: command.code };
  };
