import { describeUnresolvedGames, foldAndScore } from "@swng/domain";
import type { RoundId } from "@swng/domain";
import type { RoundViewResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { SnapshotStore } from "../ports/snapshotStore.js";
import { isParticipant } from "../scoringPolicy.js";

// GET /rounds/{roundId}/view (MCP-prep Task 7): the ONE route that hands back a FOLDED round —
// every other round-reading route (`/archive`, `/events`) serves an event log for the caller to
// fold itself, which is fine when the only caller is a phone that must fold offline anyway, but
// leaves "everything behind the API" untrue of the single most important read in the product.
//
// Auth tier is `golfer`, not a round-scoped one: mintParticipantToken throws `round-final` for a
// finalized round (mintParticipantToken.ts), so a round-scoped tier would 409 on exactly the
// finished rounds a golfer's history is made of. Authorization splits INSIDE this use case
// instead, on settledness (see below).
export const getRoundView =
  (deps: { journal: EventJournal; snapshots: SnapshotStore; golferStore: GolferStore }) =>
  async (claims: AccountClaims, roundIdValue: RoundId): Promise<RoundViewResponse> => {
    // Journal first, snapshot as the fallback. Finalize APPENDS round-finalized to the journal
    // and writes the snapshot in the SAME transaction (EventJournal.AppendOptions' `snapshot`
    // leg), and nothing ever truncates the journal — so a settled round is in BOTH stores, and
    // this reads the journal for it too, same as every live round. The snapshot branch is the
    // safety net for a round whose journal has been trimmed, not the normal path for a finished
    // round.
    const live = await deps.journal.read(roundIdValue, 0);
    const events = live.length > 0 ? live : (await deps.snapshots.get(roundIdValue))?.events;
    if (!events || events.length === 0) throw new ApplicationError("round-not-found");
    const { state, games } = foldAndScore(events);

    // Authorization splits on SETTLEDNESS, not liveness — RoundStatus has FOUR arms. A FINAL
    // round is readable by any signed-in golfer, the same rule getRoundArchive already applies
    // (a settled scorecard is already visible on every participant's own record). Everything
    // else — setup, live, abandoned — is readable only from its roster: a guard written as
    // `status === "live" ? requireRoster : allow` would leak a setup round's roster and card,
    // and an abandoned round's, to any signed-in golfer. Neither is reachable today (
    // getRoundArchive reads the snapshot only), but this route makes both reachable.
    if (state.status !== "final") {
      const found = await deps.golferStore.getBySub(claims.sub);
      if (!found || !isParticipant(state, found.golfer.id)) throw new ApplicationError("not-a-participant");
    }

    return {
      status: state.status,
      card: state.card,
      holes: state.holes,
      playedAt: state.playedAtMs,
      participants: state.participants,
      games,
      unresolved: describeUnresolvedGames(state, games),
    };
  };
