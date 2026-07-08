import type { OpId, RoundArchive, RoundEvent, RoundId } from "@swng/domain";
import type { AppendResult, EventJournal } from "../ports/eventJournal.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { Logger } from "../ports/logger.js";
import type { RoundStore } from "../ports/roundStore.js";

// In-memory ports for application's own tests AND exported product surface for lambda/E2E
// unit tests later in M3 — the Dynamo journal adapter is tested against this SAME
// contract (contiguous seq from 1, opId dedupe via duplicateOpIds), so this fake doubles
// as the spec every real journal must satisfy.
export const createInMemoryJournal = (): EventJournal => {
  const byRound = new Map<RoundId, RoundEvent[]>();
  const seenOpIds = new Map<RoundId, Set<OpId>>();

  return {
    append: async (roundId: RoundId, events: readonly RoundEvent[]): Promise<AppendResult> => {
      const stored = byRound.get(roundId) ?? [];
      const seen = seenOpIds.get(roundId) ?? new Set<OpId>();
      const appended: RoundEvent[] = [];
      const duplicateOpIds: OpId[] = [];
      let nextSeq = stored.length + 1;

      for (const event of events) {
        if (seen.has(event.opId)) {
          duplicateOpIds.push(event.opId);
          continue;
        }
        const stamped: RoundEvent = { ...event, seq: nextSeq };
        nextSeq += 1;
        stored.push(stamped);
        seen.add(event.opId);
        appended.push(stamped);
      }

      byRound.set(roundId, stored);
      seenOpIds.set(roundId, seen);
      return { appended, duplicateOpIds };
    },

    read: async (roundId: RoundId, sinceSeq: number): Promise<readonly RoundEvent[]> => {
      const stored = byRound.get(roundId) ?? [];
      return stored.filter((event) => (event.seq ?? 0) > sinceSeq);
    },
  };
};

export const createInMemoryRoundStore = (): RoundStore => {
  const roundIdByJoinCode = new Map<string, RoundId>();
  const archiveByRoundId = new Map<RoundId, RoundArchive>();

  return {
    createRound: async ({ roundId, joinCode }) => {
      roundIdByJoinCode.set(joinCode, roundId);
    },
    findByJoinCode: async (code) => roundIdByJoinCode.get(code),
    putArchive: async (archive) => {
      archiveByRoundId.set(archive.roundId, archive);
    },
  };
};

export interface CapturingBroadcast extends Broadcast {
  readonly calls: readonly { readonly roundId: RoundId; readonly events: readonly RoundEvent[] }[];
}

export const createCapturingBroadcast = (): CapturingBroadcast => {
  const calls: { roundId: RoundId; events: readonly RoundEvent[] }[] = [];
  return {
    calls,
    publish: async (roundId, events) => {
      calls.push({ roundId, events });
    },
  };
};

// Advances 1ms per call, deterministically — no wall-clock reads (conventions §4).
export const createFixedClock = (startMs: number): Clock => {
  let current = startMs;
  return {
    now: () => {
      const value = current;
      current += 1;
      return value;
    },
  };
};

export const createSequentialIds = (prefix: string): IdGenerator => {
  let idCounter = 0;
  let joinCodeCounter = 0;
  return {
    newId: () => `${prefix}-${++idCounter}`,
    newJoinCode: () => `${prefix}-join-${++joinCodeCounter}`,
  };
};

export const createNullLogger = (): Logger => ({
  info: () => {},
  error: () => {},
});
