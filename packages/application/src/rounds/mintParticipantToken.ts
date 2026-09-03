import type { RoundId } from "@swng/domain";
import type { JoinRoundResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { Logger } from "../ports/logger.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import type { RoundStore } from "../ports/roundStore.js";
import type { TokenIssuer } from "../ports/tokenIssuer.js";
import { loadRoundState } from "./loadRoundState.js";
import { writePresence } from "./presence.js";

// POST /rounds/{roundId}/token (architecture-realignment Task 14): scoring capability derives
// from PARTICIPATION, not the device that joined. A golfer seated in a round's own fold — via
// startRound (the creator) or joinRound (as-self, the only way onto a card now), on ANY device —
// can always re-mint a fresh participant token for THIS device, no join code needed. This is the
// call HomePage's live-rounds list (Task 13) makes when a
// signed-in golfer taps a round they have no local device credential for (started/joined
// elsewhere), returning the SAME wire shape joinRound's own token mint does — reused verbatim
// (task-14-brief.md: "prefer reuse") rather than a parallel MintTokenResponse type, since the
// two are byte-identical: a roundId, a token, and the golferId it authorizes.
//
// Check order is deliberate (task-14-brief.md's own binding resolution), not incidental:
// 1. The caller's OWN identity first — no golfer row at all can never be a participant of
//    anything, so this never even touches the round.
// 2. The round is folded — a nonexistent round 404s exactly the way every other round route's
//    loadRoundState call already does (loadRoundState.ts: an empty log throws round-not-found).
// 3. Participation — a signed-in stranger with a real account gets the SAME 403 a no-account
//    caller gets, never a different code that would leak "this round exists but you're not in
//    it" vs. "you have no account at all."
// 4. Liveness: a final round still 409s for an ACTUAL participant (nothing left to score —
//    the archive view, not a live session, is the read path from here), but a non-participant
//    is rejected before liveness is ever considered, so a stranger can't probe whether a round
//    they've never played is live or final.
// 5. The joinCode read (spec 2026-07-20 §2), after every authorization check — only a proven
//    participant can learn whether the round's meta item exists.
export const mintParticipantToken =
  (deps: { journal: EventJournal; golferStore: GolferStore; tokens: TokenIssuer; store: RoundStore; projectionStore: ProjectionStore; logger: Logger; clock: Clock }) =>
  async (claims: AccountClaims, id: RoundId): Promise<JoinRoundResponse> => {
    const found = await deps.golferStore.getBySub(claims.sub);
    if (!found) throw new ApplicationError("not-a-participant");

    const { state } = await loadRoundState(deps.journal, id);

    const isParticipant = state.participants.some((participant) => participant.golferId === found.golfer.id);
    if (!isParticipant) throw new ApplicationError("not-a-participant");

    if (state.status === "final") throw new ApplicationError("round-final");

    // The join code rides the credential (spec 2026-07-20 §2): a device re-minting on a new
    // phone must leave knowing the round's code, or the Join code panel goes blank (the former
    // papercut 19). A round with events but no meta item is unknown/corrupt — same 404 as any
    // missing round.
    const joinCode = await deps.store.getJoinCode(id);
    if (joinCode === undefined) throw new ApplicationError("round-not-found");

    const token = deps.tokens.issue({ scope: "participant", roundId: id, golferId: found.golfer.id });

    // Presence self-heal (2026-09-03 ticket). Seat-time is not the only moment a golfer's
    // pointer can be established, because seat-time is not reliable: writePresence is
    // best-effort by design (presence.ts — a discovery nicety must never block play), so a
    // putLive that throws once used to leave a seated golfer permanently absent from their own
    // "Your rounds", with nothing anywhere that would ever repair it.
    //
    // This is the right place to converge it, and the only one that needs no new authority: the
    // participation check above was answered by the EVENT LOG (state.participants), the source
    // of truth — not by the pointer being healed. So re-asserting it here can only ever restate
    // what the log already says. Every route back into a live round for a device holding no
    // credential passes through here (web's session/openLiveRound.ts), which makes "get in once,
    // by any means, and your pointer is rebuilt" the general recovery property.
    //
    // Unconditional, not read-then-write: putLive upserts on (golferId, roundId), so writing the
    // pointer a golfer already has is the same write it already had. Best-effort, same as every
    // other presence write — never let the home screen's convenience cost this caller the round.
    await writePresence({ projectionStore: deps.projectionStore, logger: deps.logger, clock: deps.clock }, found.golfer.id, id, state.card.courseName);

    return { roundId: id, token, golferId: found.golfer.id, joinCode };
  };
