import type { RecordScoreRequest, RecordScoreResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { Metrics } from "../ports/metrics.js";
import type { ParticipantClaims } from "../ports/tokenIssuer.js";
import { mayScore, requireParticipant } from "../scoringPolicy.js";
import { loadRoundState } from "./loadRoundState.js";

// score-recorded is the one client-authored event kind: the client supplies opId, hlc, and
// the score itself; only authorId is stamped server-side, from the verified token, so a
// client can score for someone else (score-for-anyone) but can never claim to BE someone
// else (M3 plan, Global Constraints).
export const recordScore =
  (deps: { journal: EventJournal; broadcast: Broadcast; metrics?: Metrics }) =>
  async (claims: ParticipantClaims, command: RecordScoreRequest): Promise<RecordScoreResponse> => {
    const { events, state } = await loadRoundState(deps.journal, claims.roundId);
    requireParticipant(state, claims.golferId);
    // A re-push of a score this log ALREADY holds is idempotent whatever the round's status.
    // The shape it exists for: a device pushed successfully but never pulled the confirmation,
    // so the event is still in its outbox; a later drain finds the round finalized. Refusing
    // there would report — and, before the outbox kept them, delete — a score that is safely
    // stored. This runs after the auth check (a stranger learns nothing) and before the status
    // check (the status is exactly what must not matter here). No extra read: loadRoundState
    // already returned the events.
    if (events.some((event) => event.opId === command.opId)) return { duplicate: true };
    if (state.status !== "live") {
      // `final` ONLY. A score refused by a finalized round is a real, unrecorded score: it was
      // played, it is on someone's phone, and the settled archive does not contain it. An
      // abandoned round settles nothing and counts nowhere, so refusing it loses nothing. This
      // sits AFTER the duplicate guard above deliberately — without it, a device re-pushing a
      // score that is already stored would inflate this metric with losses that never happened.
      if (state.status === "final") deps.metrics?.count("LateScoreRefused");
      throw new ApplicationError("round-not-live");
    }
    // v1's only ScoringPolicy member requires both author and subject to be participants;
    // the author half is already covered by requireParticipant above, so this call's real
    // job is gating the subject.
    if (!mayScore({ kind: "anyone-in-group" }, state, claims.golferId, command.golferId)) throw new ApplicationError("not-a-participant");

    const result = await deps.journal.append(claims.roundId, [
      { kind: "score-recorded", golferId: command.golferId, hole: command.hole, result: command.result, opId: command.opId, hlc: command.hlc, authorId: claims.golferId },
    ]);

    if (result.duplicateOpIds.includes(command.opId)) return { duplicate: true };

    await deps.broadcast.publish(claims.roundId, result.appended);
    // Non-duplicate: the client's opId always shows up in `appended`, seq-stamped.
    const appended = result.appended.find((event) => event.opId === command.opId);
    return { seq: appended!.seq, duplicate: false };
  };
