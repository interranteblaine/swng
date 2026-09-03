import type { CardId, CardRecord, CourseCard, CourseId, Crew, CrewId, Golfer, GolferId, GolferRoundLine, OpId, RoundArchive, RoundEvent, RoundId } from "@swng/domain";
import { courseNameKey, golferId } from "@swng/domain";
import { ApplicationError } from "../errors.js";
import type { AppendOptions, AppendResult, EventJournal } from "../ports/eventJournal.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { CardStore } from "../ports/cardStore.js";
import type { Clock } from "../ports/clock.js";
import type { CrewSeason, CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { Logger } from "../ports/logger.js";
import type { Metrics } from "../ports/metrics.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import type { RoundStore } from "../ports/roundStore.js";
import type { SnapshotStore } from "../ports/snapshotStore.js";
import type { TokenClaims, TokenIssuer } from "../ports/tokenIssuer.js";

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
//
// `snapshotSink` models createDynamoEventJournal's atomic finalize commit HONESTLY (the real
// adapter batches the snapshot's Put into the SAME TransactWriteItems as the EVT/OPID slots):
// when a call carries `options.snapshot` and the append lands, the snapshot is recorded into
// the sink; on a headSeqConflict early-return NOTHING is recorded, exactly as a rolled-back
// transaction would write neither. Pass the InMemorySnapshotStore created by
// createInMemorySnapshotStore below so finalizeRound's SnapshotStore reads the same map this
// writes; omit it for the many suites that never finalize (the sink is then a no-op).
export const createInMemoryJournal = (snapshotSink?: Pick<InMemorySnapshotStore, "record">): EventJournal => {
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
        // The would-be transaction rolls back whole — event AND snapshot — so the sink is
        // deliberately untouched on this path.
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
      // The append committed — the snapshot leg of the same transaction commits with it.
      if (options?.snapshot !== undefined) snapshotSink?.record(options.snapshot);
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
  const joinCodeByRoundId = new Map<RoundId, string>();

  return {
    createRound: async ({ roundId, joinCode }) => {
      roundIdByJoinCode.set(joinCode, roundId);
      joinCodeByRoundId.set(roundId, joinCode);
    },
    findByJoinCode: async (code) => roundIdByJoinCode.get(code),
    getJoinCode: async (roundId) => joinCodeByRoundId.get(roundId),
  };
};

// The read side of the snapshots table (SnapshotStore's port doc), plus a `record` write side
// that is NOT part of the port — the real adapter only ever gets a snapshot written through
// EventJournal.append's transaction, and this fake mirrors that: hand this store to
// createInMemoryJournal above so its atomic finalize commit records here, and finalizeRound's
// `snapshots.get` reads it back. `record` sits outside SnapshotStore so no production caller
// can reach a write path the real system doesn't have.
export interface InMemorySnapshotStore extends SnapshotStore {
  readonly record: (archive: RoundArchive) => void;
}
// `pageSize` mirrors createDynamoSnapshotStore's own `pageLimit` test injection (adapters-
// dynamodb): omitted, `page()` hands back the whole table in one shot (every OTHER caller of
// this fake needs no pagination at all); set it and `page()` walks insertion order in fixed-
// size chunks, cursor-driven — the ONE caller that needs this is rebuildProjections.test.ts
// (realignment Task 5), forcing its paged-backfill loop across several real pages the same way
// the Dynamo contract suite forces createDynamoSnapshotStore across several real Scan pages.
// The cursor itself is just the next start index, stringified — opaque to callers exactly like
// the real adapter's base64url LastEvaluatedKey (SnapshotStore's port doc promises opacity,
// never a shape), and stable across repeat calls with the SAME cursor as long as nothing new
// is `record`ed in between (insertion order into a Map never reshuffles).
export const createInMemorySnapshotStore = (config?: { readonly pageSize?: number }): InMemorySnapshotStore => {
  const byRoundId = new Map<RoundId, RoundArchive>();
  return {
    record: (archive) => {
      byRoundId.set(archive.roundId, archive);
    },
    get: async (roundId) => byRoundId.get(roundId),
    // Order isn't promised and absent ids are omitted (SnapshotStore's port doc) — a flatMap
    // that drops the misses reproduces a BatchGetItem's own contract.
    getMany: async (roundIds) =>
      roundIds.flatMap((id) => {
        const archive = byRoundId.get(id);
        return archive ? [archive] : [];
      }),
    page: async (cursor) => {
      const all = [...byRoundId.values()];
      const pageSize = config?.pageSize ?? all.length;
      const start = cursor !== undefined ? Number(cursor) : 0;
      const snapshots = pageSize > 0 ? all.slice(start, start + pageSize) : all.slice(start);
      const next = start + snapshots.length;
      return { snapshots, cursor: next < all.length ? String(next) : undefined };
    },
  };
};

// CardStore's real adapter (course-cards spec §5) is a write-once card lineage under one
// CURRENT pointer; this fake reproduces it without Dynamo — one append-only Array<CardRecord>
// per courseId (current = the last element). `supersede` is the store's own concurrency
// arbiter: it throws card-superseded unless the last element's cardId still names the card the
// caller reviewed (record.supersedes) — the same one rule the Dynamo transact condition
// enforces (spec §6). search is a linear courseNameKey-prefix scan over CURRENT pointers only.
export const createInMemoryCardStore = (): CardStore => {
  const lineages = new Map<CourseId, CardRecord[]>();
  return {
    create: async (record) => {
      if (lineages.has(record.courseId)) throw new ApplicationError("card-superseded", `course ${record.courseId} already exists`);
      lineages.set(record.courseId, [record]);
    },
    supersede: async (record) => {
      const lineage = lineages.get(record.courseId);
      const current = lineage?.[lineage.length - 1];
      if (!lineage || !current) throw new ApplicationError("course-not-found");
      if (current.cardId !== record.supersedes) throw new ApplicationError("card-superseded", `course ${record.courseId}: the CURRENT pointer has moved`);
      lineage.push(record);
    },
    getCurrent: async (id) => {
      const lineage = lineages.get(id);
      return lineage?.[lineage.length - 1];
    },
    search: async (nameKeyPrefix, limit) =>
      [...lineages.values()]
        .map((lineage) => lineage[lineage.length - 1]!)
        .filter((record) => courseNameKey(record.card.courseName).startsWith(nameKeyPrefix))
        .slice(0, limit)
        .map((record) => ({ courseId: record.courseId, name: record.card.courseName, holeCount: record.card.teeSets[0]!.holes.length as 9 | 18 })),
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
    // Order isn't promised and absent ids are omitted (GolferStore's port doc) — a flatMap that
    // drops the misses reproduces a BatchGetItem's own contract, same as the snapshot fake above.
    getMany: async (golferIds) =>
      golferIds.flatMap((id) => {
        const found = byId.get(id);
        return found ? [{ golfer: found.golfer, sub: found.sub, revision: found.revision }] : [];
      }),
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

// Test convenience: seeds a FRESH account golfer (a sub-bound row) in one call — `put`s a
// sub-less row, then `bindSub`s it. Exists because GolferStore.bindSub (M9 hardening) never
// creates a row itself (golferStore.ts's port doc), so a test that wants an account golfer bound
// to a sub needs the same two-step dance — collapsed back to one call here rather than
// copy-pasted at every call site (conventions §0: three-plus call sites is the extraction trigger).
export const putAndBindGolfer = async (store: GolferStore, id: GolferId, sub: string, name: string): Promise<void> => {
  await store.put({ id, name }, undefined);
  await store.bindSub(id, sub);
};

// StartRound resolves cards by REFERENCE now (course-cards spec §4): callers no longer author a
// card, so tests need a lineage seeded straight into the CardStore port rather than a bare
// CourseCard value. Bypasses CreateCourse/buildCardRecord on purpose — several golden domain
// fixtures (fixtureLinks et al.) predate teeId and buildCardRecord demands one on every tee.
// Returns the seeded CardRecord so the caller can pass `{ courseId: record.courseId, cardId:
// record.cardId }` straight into StartRoundRequest.course.
export const seedCard = async (store: CardStore, courseId: CourseId, id: CardId, card: CourseCard): Promise<CardRecord> => {
  const record: CardRecord = {
    cardId: id,
    courseId,
    card,
    enteredBy: { golferId: golferId("fixture-enterer"), name: "Fixture Enterer" },
    enteredAtMs: 0,
    provenance: "community",
  };
  await store.create(record);
  return record;
};

// CrewStore's real adapter (M8 Task 3; the permanent join code + its gsi1 partition are GONE
// as of crew membership's "invited in" rework — getting in is an expiring HMAC invite link
// now, never a store-resident lookup) lives on the `core` table plus a golfer→crews GSI
// (architecture.md's persistence sketch); this fake reproduces it without Dynamo — a Map keyed
// by crewId for get/put's optimistic concurrency (same expectedRevision contract as
// courseStore's/golferStore's fakes), and a linear scan for listByGolfer (fine at fake/test
// scale; the real GSI is what makes this cheap in adapters-dynamodb).
export const createInMemoryCrewStore = (): CrewStore => {
  const byId = new Map<CrewId, { crew: Crew; revision: number }>();
  // Seasons (task-8-brief.md), reproducing createDynamoCrewStore's own key scheme without
  // Dynamo: one Map<seasonId, CrewSeason> per crew. The counting apparatus this used to also
  // reproduce (a parallel per-crew map of counted-round entries, populated by the old
  // append-a-round use case) is deleted whole (crew-scoreboard spec §2b) — countsRound below
  // now always answers false in the fake, since nothing writes to it anymore (the real adapter
  // still answers legacy orphaned beta data; there is no such legacy data to reproduce here).
  const seasonsByCrew = new Map<CrewId, Map<string, CrewSeason>>();

  // Guard: seasonId MUST NOT contain "#" (mirrors createDynamoCrewStore's validator — the key
  // vocabulary composites it under a shared prefix legacy orphaned counted-round items also
  // use, so a "#" in seasonId would create a collision breaking the ability to filter those
  // orphans apart from real season items).
  const validateSeasonId = (seasonId: string): void => {
    if (seasonId.includes("#")) {
      throw new Error(`seasonId contains "#" — key vocabulary collision: "${seasonId}"`);
    }
  };

  return {
    put: async (crew, expectedRevision) => {
      const existing = byId.get(crew.id);
      if (expectedRevision === undefined) {
        if (existing) throw new ApplicationError("crew-conflict", `crew ${crew.id} already exists`);
        byId.set(crew.id, { crew, revision: 1 });
        return;
      }
      if (!existing || existing.revision !== expectedRevision) {
        throw new ApplicationError("crew-conflict", `crew ${crew.id} revision mismatch (expected ${expectedRevision})`);
      }
      byId.set(crew.id, { crew, revision: existing.revision + 1 });
    },
    get: async (crewId) => {
      const found = byId.get(crewId);
      return found ? { crew: found.crew, revision: found.revision } : undefined;
    },
    listByGolfer: async (golferId) =>
      [...byId.values()]
        .filter(({ crew }) => crew.members.some((member) => member.golferId === golferId))
        .map(({ crew }) => ({ crewId: crew.id, name: crew.name, memberCount: crew.members.length })),

    putSeason: async (crewId, season) => {
      validateSeasonId(season.seasonId);
      const seasons = seasonsByCrew.get(crewId) ?? new Map<string, CrewSeason>();
      seasons.set(season.seasonId, season); // unconditional upsert — create/rename/close all land here
      seasonsByCrew.set(crewId, seasons);
    },
    getSeason: async (crewId, seasonId) => seasonsByCrew.get(crewId)?.get(seasonId),
    // NO ORDER PROMISED (port doc) — insertion order here is incidental, never relied upon.
    listSeasons: async (crewId) => [...(seasonsByCrew.get(crewId)?.values() ?? [])],

    // Always false: the counting apparatus that used to populate this is deleted whole
    // (crew-scoreboard spec §2b), and this in-memory fake has no legacy orphaned data to
    // reproduce the way the real DynamoDB adapter still can.
    countsRound: async () => false,
  };
};

// ProjectionStore's real adapter (M7 Task 3, extended M8, keys stabilized in the
// projection-realignment) lives on the `projections` table, one golfer partition holding
// ROUND#/LIVE# items — this fake mirrors it with one Map per golfer keyed by roundId
// (upsert-by-roundId is the whole point of the stable-key rewrite: a repeat putLine for the
// same round REPLACES the Map entry, never adds a second one). listLines deliberately does NOT
// sort — the port's own contract is UNORDERED (ports/projectionStore.ts); every caller
// (getMyRecord.ts's own sortLines use) imposes order itself, and a fake that quietly sorted
// here would let a caller that forgot to sort pass anyway. There is no index Map: the handicap
// index is computed at read time (pre-prod hardening D4a, golfers/getMyRecord.ts), never
// stored by anything this fake needs to model.
export const createInMemoryProjectionStore = (): ProjectionStore => {
  const linesByGolfer = new Map<GolferId, Map<RoundId, GolferRoundLine & { finalizedAtMs: number; playedAtMs: number; createdAtMs?: number }>>();
  const liveByGolfer = new Map<GolferId, Map<RoundId, { roundId: RoundId; courseName: string; joinedAtMs: number }>>();

  return {
    putLine: async (golferId, line) => {
      const lines = linesByGolfer.get(golferId) ?? new Map<RoundId, GolferRoundLine & { finalizedAtMs: number; playedAtMs: number; createdAtMs?: number }>();
      lines.set(line.roundId, line); // upsert by roundId — REPLACES on a reopen-and-refinalize, never adds a second entry
      linesByGolfer.set(golferId, lines);
    },
    listLines: async (golferId) => [...(linesByGolfer.get(golferId)?.values() ?? [])],
    putLive: async (golferId, entry) => {
      const live = liveByGolfer.get(golferId) ?? new Map<RoundId, { roundId: RoundId; courseName: string; joinedAtMs: number }>();
      live.set(entry.roundId, entry); // upsert by roundId
      liveByGolfer.set(golferId, live);
    },
    deleteLive: async (golferId, roundId) => {
      liveByGolfer.get(golferId)?.delete(roundId);
    },
    listLive: async (golferId) =>
      [...(liveByGolfer.get(golferId)?.values() ?? [])].map(({ roundId, courseName, joinedAtMs }) => ({ roundId, courseName, joinedAtMs })),
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

// A local, in-memory TokenIssuer — the SAME idiom several use-case test files each hand-rolled
// independently (getShareLink.test.ts's own doc comment names terminateGame.test.ts/
// finalizeRound.test.ts's copies), promoted here now that crew-invite testing (crewSlice.test.ts/
// seasonSlice.test.ts/mintCrewInvite.test.ts/peekCrewInvite.test.ts/joinCrewByInvite.test.ts) pushes
// the call-site count past the three-plus extraction trigger (conventions §0). Keyed by an
// incrementing counter, not the claims' own value (unlike getShareLink.test.ts's OWN fake, which
// needs same-claims-in ⇒ same-token-out determinism to pin getShareLink's own contract) — every
// crew-invite claim these tests mint is already unique enough (nothing here asserts token
// byte-identity), and a plain counter is simpler.
export const createTestTokenIssuer = (): TokenIssuer => {
  const claimsByToken = new Map<string, TokenClaims>();
  let counter = 0;
  return {
    issue: (claims) => {
      const token = `token-${(counter += 1)}`;
      claimsByToken.set(token, claims);
      return token;
    },
    verify: (token) => claimsByToken.get(token),
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
  warn: () => {},
  error: () => {},
});

// Records every warn() call (message + data) — exists for the ONE assertion createNullLogger
// can't make: that a caller actually DID warn (realignment Task 13's "presence write failure
// must not fail the seating act, but it must still be logged" — startRound's/joinRound's own
// tests pin both halves of that with this fake).
export interface CapturingLogger extends Logger {
  readonly warnings: readonly { readonly message: string; readonly data?: Record<string, unknown> }[];
}

export const createCapturingLogger = (): CapturingLogger => {
  const warnings: { message: string; data?: Record<string, unknown> }[] = [];
  return {
    warnings,
    info: () => {},
    warn: (message, data) => {
      warnings.push({ message, data });
    },
    error: () => {},
  };
};

export const createNullMetrics = (): Metrics => ({ count: () => {} });

// Records every count() call by metric name — the Metrics analogue of CapturingLogger, for the
// ONE assertion createNullMetrics can't make: that a use case actually emitted (and, on the
// replay/race-loser branches, did NOT).
export interface CapturingMetrics extends Metrics {
  readonly calls: readonly string[];
}

export const createCapturingMetrics = (): CapturingMetrics => {
  const calls: string[] = [];
  return {
    calls,
    count: (name) => {
      calls.push(name);
    },
  };
};
