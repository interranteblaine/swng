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
//
// One deliberate divergence, scoped here rather than left implicit: an in-batch duplicate
// opId (two events in the SAME `events` array sharing an opId) dedupes cleanly in this fake
// (the loop below sees the second one as already `seen`) but would throw a DynamoDB
// ValidationException in createDynamoEventJournal — a single TransactWriteCommand can't
// carry two Put operations against the same item key (opIdSk(event.opId) collides). This is
// unreachable by every current caller: every real batch is either 1 event (RecordScore,
// FinalizeRound) or 3 freshly-minted events with distinct opIds (StartRound).
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

// The same human-facing alphabet compositionRoot.ts's real `newJoinCode` draws from (no
// 0/O/1/I/L — visually unambiguous read aloud or typed on a phone).
const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

// join codes are a distinct wire shape from newId's free-form "prefix-N": the real command
// schema (contracts' joinRoundRequestSchema) requires exactly 6 characters drawn from
// JOIN_CODE_ALPHABET. This module's doc comment declares it the exported surface for
// lambda/E2E tests too, so a fake code has to honor that shape, not just look plausible —
// a two-char head deterministically derived from `prefix` (so different fakes' codes stay
// visually distinct), plus the counter zero-padded to 4 decimal digits and mapped
// digit-by-digit into the alphabet's first 10 entries. The tail is injective for the first
// 10,000 codes per instance (`counter % 10_000` wraps after that, so a generator instance
// pushed past 10,000 join codes could repeat a tail) — comfortably beyond any test run's
// call count.
const joinCodeFromCounter = (prefix: string, counter: number): string => {
  const prefixHash = [...prefix].reduce((sum, char, index) => sum + char.charCodeAt(0) * (index + 1), 0);
  const head = `${JOIN_CODE_ALPHABET[prefixHash % JOIN_CODE_ALPHABET.length]}${JOIN_CODE_ALPHABET[(prefixHash * 7) % JOIN_CODE_ALPHABET.length]}`;
  const tailDigits = String(counter % 10_000).padStart(4, "0");
  const tail = [...tailDigits].map((digit) => JOIN_CODE_ALPHABET[Number(digit)]).join("");
  return `${head}${tail}`;
};

export const createSequentialIds = (prefix: string): IdGenerator => {
  let idCounter = 0;
  let joinCodeCounter = 0;
  return {
    newId: () => `${prefix}-${++idCounter}`,
    newJoinCode: () => joinCodeFromCounter(prefix, ++joinCodeCounter),
  };
};

export const createNullLogger = (): Logger => ({
  info: () => {},
  error: () => {},
});
