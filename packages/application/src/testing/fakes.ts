import type { Course, CourseId, Crew, CrewId, CrewRoundContribution, Golfer, GolferId, GolferRoundLine, OpId, RoundArchive, RoundEvent, RoundId } from "@swng/domain";
import { courseNameKey } from "@swng/domain";
import { ApplicationError } from "../errors.js";
import type { AppendOptions, AppendResult, EventJournal } from "../ports/eventJournal.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { CourseStore } from "../ports/courseStore.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { Logger } from "../ports/logger.js";
import type { CrewSeasonRecords, ProjectionStore } from "../ports/projectionStore.js";
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
    append: async (roundId: RoundId, events: readonly RoundEvent[], options?: AppendOptions): Promise<AppendResult> => {
      const stored = byRound.get(roundId) ?? [];
      // Contiguous seq from 1 means the current head IS the stored length — same fact
      // createDynamoEventJournal's headSeq query answers with a real Query, this fake
      // answers with the array it already has.
      const headSeq = stored.length;
      if (options?.expectedHeadSeq !== undefined && options.expectedHeadSeq !== headSeq) {
        return { appended: [], duplicateOpIds: [], headSeqConflict: true };
      }

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
    getArchive: async (roundId) => archiveByRoundId.get(roundId),
  };
};

// CourseStore's real adapter (M6 Task 3) is a plain CRUD item + a name-prefix GSI; this
// fake reproduces both without Dynamo — a Map keyed by courseId for get/put's optimistic
// concurrency (the same expectedRevision contract the port doc specifies), and a linear
// courseNameKey-prefix scan for search (fine at fake/test scale; the real GSI is what
// makes this cheap in adapters-dynamodb).
export const createInMemoryCourseStore = (): CourseStore => {
  const byId = new Map<CourseId, { course: Course; revision: number }>();

  return {
    put: async (course, expectedRevision) => {
      const existing = byId.get(course.courseId);
      if (expectedRevision === undefined) {
        if (existing) throw new ApplicationError("course-conflict", `course ${course.courseId} already exists`);
        byId.set(course.courseId, { course, revision: 1 });
        return;
      }
      if (!existing || existing.revision !== expectedRevision) {
        throw new ApplicationError("course-conflict", `course ${course.courseId} revision mismatch (expected ${expectedRevision})`);
      }
      byId.set(course.courseId, { course, revision: existing.revision + 1 });
    },
    get: async (courseId) => {
      const found = byId.get(courseId);
      return found ? { course: found.course, revision: found.revision } : undefined;
    },
    search: async (nameKeyPrefix, limit) =>
      [...byId.values()]
        .filter(({ course }) => courseNameKey(course.name).startsWith(nameKeyPrefix))
        .slice(0, limit)
        .map(({ course }) => ({ courseId: course.courseId, name: course.name })),
  };
};

// GolferStore's real adapter (M7 Task 3) is a plain CRUD item on the core table plus a
// sub-lookup GSI; this fake reproduces both without Dynamo — a Map keyed by golferId for
// get/put's optimistic concurrency (the same expectedRevision contract courseStore's fake
// honors), and a linear scan for getBySub (fine at fake/test scale; the real GSI is what
// makes this cheap in adapters-dynamodb).
export const createInMemoryGolferStore = (): GolferStore => {
  const byId = new Map<GolferId, { golfer: Golfer; sub?: string; revision: number }>();

  return {
    put: async (golfer, expectedRevision) => {
      const { sub, ...plain } = golfer;
      const existing = byId.get(golfer.id);
      if (expectedRevision === undefined) {
        if (existing) throw new ApplicationError("golfer-conflict", `golfer ${golfer.id} already exists`);
        byId.set(golfer.id, { golfer: plain, sub, revision: 1 });
        return;
      }
      if (!existing || existing.revision !== expectedRevision) {
        throw new ApplicationError("golfer-conflict", `golfer ${golfer.id} revision mismatch (expected ${expectedRevision})`);
      }
      // M9 hardening: refuse a replace that would silently clear a currently-bound sub —
      // mirrors createDynamoGolferStore's own guard (golferStore.ts's port doc:
      // "sub-drop-forbidden").
      if (existing.sub !== undefined && sub === undefined) {
        throw new ApplicationError("sub-drop-forbidden", `put on golfer ${golfer.id} would drop its bound sub`);
      }
      byId.set(golfer.id, { golfer: plain, sub, revision: existing.revision + 1 });
    },
    get: async (golferId) => {
      const found = byId.get(golferId);
      return found ? { golfer: found.golfer, sub: found.sub, revision: found.revision } : undefined;
    },
    getBySub: async (sub) => {
      for (const entry of byId.values()) {
        if (entry.sub === sub) return { golfer: entry.golfer, sub, revision: entry.revision };
      }
      return undefined;
    },
    // Mirrors createDynamoGolferStore's TransactWriteItems bindSub in EFFECT (golferStore.ts's
    // port doc): this fake is single-threaded so there's no real race to arbitrate, but the two
    // invariants enforced are the SAME ones the real transaction's two conditions enforce — the
    // sub isn't already bound to a DIFFERENT golferId, and this golferId isn't already bound to
    // a (necessarily different, since sub is a fresh param here) sub. Requires the row to
    // already exist, same as the real adapter's attribute_exists(pk) condition — bindSub never
    // creates one.
    bindSub: async (golferId, sub) => {
      const existing = byId.get(golferId);
      if (!existing) throw new Error(`bindSub: golfer ${golferId} has no row yet — put it first`);
      const boundElsewhere = [...byId.entries()].some(([id, entry]) => id !== golferId && entry.sub === sub);
      if (boundElsewhere || existing.sub !== undefined) {
        throw new ApplicationError("golfer-already-claimed", `golfer ${golferId} could not be bound to the given sub`);
      }
      byId.set(golferId, { golfer: existing.golfer, sub, revision: existing.revision + 1 });
    },
  };
};

// Test convenience: seeds a FRESH, claimed golfer row in one call — `put`s it unclaimed, then
// `bindSub`s it. Exists because GolferStore.bindSub (M9 hardening) no longer creates a row
// itself the way the old single-call `claim` did (golferStore.ts's port doc), so every test
// across this package that used to seed a claimed golfer with one `claim(id, sub, name)` call
// needs the same two-step dance — collapsed back to one call here rather than copy-pasted at
// every call site (conventions §0: three-plus call sites is exactly the extraction trigger).
export const putAndBindGolfer = async (store: GolferStore, id: GolferId, sub: string, name: string): Promise<void> => {
  await store.put({ id, name, handicap: {} }, undefined);
  await store.bindSub(id, sub);
};

// CrewStore's real adapter (M8 Task 3) lives on the `core` table plus a join-code GSI and a
// golfer→crews GSI (architecture.md's persistence sketch); this fake reproduces both without
// Dynamo — a Map keyed by crewId for get/put's optimistic concurrency (same expectedRevision
// contract as courseStore's/golferStore's fakes), a second Map for the join-code index, and
// a linear scan for listByGolfer (fine at fake/test scale; the real GSI is what makes this
// cheap in adapters-dynamodb).
export const createInMemoryCrewStore = (): CrewStore => {
  const byId = new Map<CrewId, { crew: Crew; joinCode: string; revision: number }>();
  const idByJoinCode = new Map<string, CrewId>();

  return {
    put: async (crew, joinCode, expectedRevision) => {
      const existing = byId.get(crew.id);
      if (expectedRevision === undefined) {
        if (existing) throw new ApplicationError("crew-conflict", `crew ${crew.id} already exists`);
        byId.set(crew.id, { crew, joinCode, revision: 1 });
        idByJoinCode.set(joinCode, crew.id);
        return;
      }
      if (!existing || existing.revision !== expectedRevision) {
        throw new ApplicationError("crew-conflict", `crew ${crew.id} revision mismatch (expected ${expectedRevision})`);
      }
      byId.set(crew.id, { crew, joinCode: existing.joinCode, revision: existing.revision + 1 });
    },
    get: async (crewId) => {
      const found = byId.get(crewId);
      return found ? { crew: found.crew, joinCode: found.joinCode, revision: found.revision } : undefined;
    },
    findByJoinCode: async (joinCode) => idByJoinCode.get(joinCode),
    listByGolfer: async (golferId) =>
      [...byId.values()]
        .filter(({ crew }) => crew.members.some((member) => member.golferId === golferId))
        .map(({ crew }) => ({ crewId: crew.id, name: crew.name, memberCount: crew.members.length })),
  };
};

// ProjectionStore's real adapter (M7 Task 3, extended M8) lives on the `projections` table,
// sk-ordered so listHistory's oldest-first read is free (architecture.md §3); this fake
// reproduces that ordering explicitly via a sort, since a Map's insertion order isn't a
// promise this port doc makes.
export const createInMemoryProjectionStore = (): ProjectionStore => {
  const historyByGolfer = new Map<GolferId, Map<RoundId, GolferRoundLine & { finalizedAtMs: number }>>();
  const indexByGolfer = new Map<GolferId, { value: number; computedAtMs: number; differentialsUsed: number }>();
  // Keyed by "crewId#season" — mirrors the real adapter's LEDGER#crew#season sort-key shape
  // (architecture.md) closely enough for a fake without actually building a composite-key
  // Map type.
  const crewRoundsByKey = new Map<string, Map<RoundId, CrewRoundContribution & { finalizedAtMs: number }>>();
  const seasonRecordsByKey = new Map<string, CrewSeasonRecords>();
  const crewSeasonKey = (crewId: CrewId, season: number): string => `${crewId}#${season}`;

  return {
    putHistoryLine: async (golferId, line) => {
      const lines = historyByGolfer.get(golferId) ?? new Map<RoundId, GolferRoundLine & { finalizedAtMs: number }>();
      lines.set(line.roundId, line); // upsert by roundId
      historyByGolfer.set(golferId, lines);
    },
    listHistory: async (golferId) => [...(historyByGolfer.get(golferId)?.values() ?? [])].sort((a, b) => a.finalizedAtMs - b.finalizedAtMs),
    putIndex: async (golferId, snapshot) => {
      indexByGolfer.set(golferId, snapshot);
    },
    getIndex: async (golferId) => indexByGolfer.get(golferId),
    wipeGolfer: async (golferId) => {
      historyByGolfer.delete(golferId);
      indexByGolfer.delete(golferId);
    },
    putCrewRound: async (crewId, season, entry) => {
      const key = crewSeasonKey(crewId, season);
      const rounds = crewRoundsByKey.get(key) ?? new Map<RoundId, CrewRoundContribution & { finalizedAtMs: number }>();
      rounds.set(entry.roundId, entry); // upsert by roundId — never accumulated
      crewRoundsByKey.set(key, rounds);
    },
    listCrewRounds: async (crewId, season) => [...(crewRoundsByKey.get(crewSeasonKey(crewId, season))?.values() ?? [])],
    putSeasonRecords: async (crewId, season, records) => {
      seasonRecordsByKey.set(crewSeasonKey(crewId, season), records);
    },
    getSeasonRecords: async (crewId, season) => seasonRecordsByKey.get(crewSeasonKey(crewId, season)),
    wipeCrew: async (crewId, seasons) => {
      for (const season of seasons) {
        const key = crewSeasonKey(crewId, season);
        crewRoundsByKey.delete(key);
        seasonRecordsByKey.delete(key);
      }
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

// A clock that never advances — every call to now() returns the same wallMs. Exists
// specifically to exercise createServerHlcSource's collision-avoidance path (serverEnvelope.ts):
// createFixedClock above advances 1ms per call, which never lets a same-millisecond batch
// occur, so it can't catch the M3 status-register bug (StartRound's three server events
// landing on identical hlcs and racing on random opId for canonical order). This fake
// reproduces the real-world condition — a fast server minting several events within one
// clock tick — deterministically.
export const createFrozenClock = (atMs: number): Clock => ({
  now: () => atMs,
});

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
