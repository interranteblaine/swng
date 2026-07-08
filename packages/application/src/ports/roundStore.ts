import type { RoundArchive, RoundId } from "@swng/domain";

// The thin key-value store around a round's non-log facts: the join-code lookup a round
// needs before its own log exists to find it by, and the terminal archive a finalized
// round settles into. The event log itself lives behind EventJournal, not here.
export interface RoundStore {
  createRound(meta: { roundId: RoundId; joinCode: string }): Promise<void>;
  findByJoinCode(code: string): Promise<RoundId | undefined>;
  putArchive(archive: RoundArchive): Promise<void>;
}
