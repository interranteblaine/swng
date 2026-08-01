import { playedAtMsOf } from "@swng/domain";
import type { RoundId } from "@swng/domain";
import type { GetMyLiveRoundsResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";

// playedAt (spec 2026-08-01 §4b): WHEN THE GOLF HAPPENED — through the ONE shared rule (domain's
// playedAtMsOf), a ROUND-level fact (unlike the per-golfer `joinedAt`). Derived at read time
// rather than stored on the presence pointer: presence is written by startRound/joinRound (the
// only two seat paths), and a golfer has only a handful of live rounds at once, so a log read per
// live round is cheap. `undefined` iff the log is genuinely empty (an unknown round, per
// EventJournal.read's own contract) — a stale presence pointer (the 36h TTL backstop outliving a
// round that vanished) reads back nothing. playedAt is REQUIRED on the wire (unlike the old
// best-effort createdAt), so that case drops the ENTRY, never serves a fact-free stub.
const playedAtOf = async (journal: EventJournal, roundId: RoundId): Promise<number | undefined> => {
  const events = await journal.read(roundId, 0);
  return events.length === 0 ? undefined : playedAtMsOf(events);
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
    const withPlayedAt = await Promise.all(
      sorted.map(async (entry) => {
        const playedAt = await playedAtOf(deps.journal, entry.roundId);
        return playedAt === undefined ? undefined : { roundId: entry.roundId, courseName: entry.courseName, joinedAt: entry.joinedAtMs, playedAt };
      }),
    );
    // Drop a stale pointer's entry entirely (a vanished round has nothing honest to show) rather
    // than serving a partial object missing the now-REQUIRED playedAt.
    return { rounds: withPlayedAt.filter((round) => round !== undefined) };
  };
