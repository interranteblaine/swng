import type { RoundArchive, RoundId } from "@swng/domain";

// The thin key-value store around a round's non-log facts: the join-code lookup a round
// needs before its own log exists to find it by, and the terminal archive a finalized
// round settles into. The event log itself lives behind EventJournal, not here.
export interface RoundStore {
  createRound(meta: { roundId: RoundId; joinCode: string }): Promise<void>;
  findByJoinCode(code: string): Promise<RoundId | undefined>;
  putArchive(archive: RoundArchive): Promise<void>;
  // M9 hardening: reads the settled archive for a round, if one has actually been written.
  // undefined covers TWO cases a caller must be able to tell apart from a live round's own
  // "not final yet" — a round that's genuinely still live, AND the repair-on-replay wedge
  // (finalizeRound.ts): round-finalized landed in the journal but putArchive threw before it
  // ever wrote. finalizeRound's idempotent branch calls this FIRST and only recomputes when
  // it's missing, so a retry never reports success while the archive row stays absent.
  getArchive(roundId: RoundId): Promise<RoundArchive | undefined>;
}
