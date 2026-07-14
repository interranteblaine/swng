import type { RoundId } from "@swng/domain";
import type { GetMyLiveRoundsResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";

// The round's created-at (accounts-only identity spec §5, the "course + date" designation) — the
// round-created genesis event's own wall time, a ROUND-level fact (unlike the per-golfer
// `joinedAt`). Derived at read time rather than stored on the presence pointer: presence is written
// by startRound/joinRound (the only two seat paths), and a golfer has only a handful
// of live rounds at once, so a genesis read per live round is cheap. Best-effort — a stale presence
// pointer (the 36h TTL backstop outliving a round that vanished) reads back nothing, so createdAt is
// simply omitted rather than throwing.
const createdAtOf = async (journal: EventJournal, roundId: RoundId): Promise<number | undefined> => {
  const events = await journal.read(roundId, 0);
  return events.find((event) => event.kind === "round-created")?.hlc.wallMs;
};

// GET /me/rounds/live (projection-realignment Task 13): "your rounds, right now" — every LIVE
// presence pointer under the caller's own golfer identity (rounds/presence.ts's writePresence
// writes these at seat-time; projections/projectArchive.ts's deleteLive loop removes them at
// finalize). No get-or-create (getMyRecord.ts/getMyRounds.ts's own precedent) — a sub with no
// golfer row yet has no presence to have, so `{ rounds: [] }` is already the honest answer.
export const getMyLiveRounds =
  (deps: { golferStore: GolferStore; projectionStore: ProjectionStore; journal: EventJournal }) =>
  async (claims: AccountClaims): Promise<GetMyLiveRoundsResponse> => {
    const found = await deps.golferStore.getBySub(claims.sub);
    if (!found) return { rounds: [] };

    const live = await deps.projectionStore.listLive(found.golfer.id);
    // listLive is UNORDERED (ports/projectionStore.ts, same discipline as listLines) — sort
    // here, newest-joined first, rather than trusting the store's own iteration order.
    const sorted = [...live].sort((a, b) => b.joinedAtMs - a.joinedAtMs);
    const rounds = await Promise.all(
      sorted.map(async (entry) => {
        const createdAt = await createdAtOf(deps.journal, entry.roundId);
        return { roundId: entry.roundId, courseName: entry.courseName, joinedAt: entry.joinedAtMs, ...(createdAt !== undefined ? { createdAt } : {}) };
      }),
    );
    return { rounds };
  };
