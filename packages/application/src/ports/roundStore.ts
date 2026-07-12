import type { RoundId } from "@swng/domain";

// The thin key-value store around a round's non-log facts: the join-code lookup a round needs
// before its own log exists to find it by. The event log itself lives behind EventJournal; the
// terminal settled archive lives on the snapshots table behind SnapshotStore (written only by
// EventJournal.append's atomic finalize commit) — neither is this store's concern any longer.
export interface RoundStore {
  createRound(meta: { roundId: RoundId; joinCode: string }): Promise<void>;
  findByJoinCode(code: string): Promise<RoundId | undefined>;
}
