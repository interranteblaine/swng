import type { CourseId, CrewId, GolferId, OpId, RoundId } from "@swng/domain";
import { courseId, crewId, golferId } from "@swng/domain";

// The rounds table's key vocabulary (M3 plan, Global Constraints): one item collection per
// round (`pk`), holding the event log (`EVT#<seq>`, sorted lexically in seq order because
// the padding fixes every sk to the same width), the mutable pointer to itself (`META`, also
// the gsi1 join-code lookup target), and one tombstone per ingested opId (`OPID#<id>`) that
// makes append's dedupe a plain conditional put. The terminal settlement no longer lives here
// — the projection-realignment moved it to its own snapshots table (snapshotPk below), written
// atomically with round-finalized by the finalize transaction.
export const roundPk = (id: RoundId): string => `ROUND#${id}`;

// Zero-padded to 10 digits so string (lexical) order and numeric order agree — the property
// the head-seq query (ScanIndexForward: false, Limit: 1) and the ranged read both depend on.
// 10 digits is headroom no real round's event count will ever approach (architecture.md's
// scale check: a few thousand events across an entire outing).
export const evtSk = (seq: number): string => `EVT#${String(seq).padStart(10, "0")}`;

// The lexically-last possible EVT# sort key — the upper bound of the `read` range query.
// Derived from evtSk rather than a hand-typed literal so the two never drift apart.
export const evtSkMax: string = evtSk(9_999_999_999);

export const metaSk = "META";

export const opIdSk = (id: OpId): string => `OPID#${id}`;

// The snapshots table's key vocabulary (projection-realignment spec §1/§11: "the snapshot IS
// the atom"): pk-only, and the pk is the BARE roundId — a key is an identity, not a namespaced
// path (unlike roundPk's "ROUND#" prefix, which shares one table across many item kinds; the
// snapshots table holds exactly one item kind, so it needs no discriminator). Time is the
// `finalizedAt` attribute, never a sort key — the table has no sk at all. The item is written
// only by createDynamoEventJournal's atomic finalize transaction and read by
// createDynamoSnapshotStore; both go through this one helper so the format can't drift.
export const snapshotPk = (id: RoundId): string => id;

// The connections table's key vocabulary: one item per live WS connection, looked up by its
// own id on register/deregister and fanned out to via gsi1 on roundId for broadcast.
export const connPk = (connectionId: string): string => `CONN#${connectionId}`;

// The core table's course-item key vocabulary (M6 Task 3): a Course aggregate is a plain
// CRUD document (CourseStore's port comment), so unlike the rounds table there's no event
// collection per id — one item, `pk` = coursePk(id) / `sk` fixed to COURSE.
const COURSE_PK_PREFIX = "COURSE#";
export const coursePk = (id: CourseId): string => `${COURSE_PK_PREFIX}${id}`;
export const courseSk = "COURSE";

// courseId parses back out of a projected gsi1 item's `pk` — a base table's own key
// attributes are always projected onto a GSI regardless of ProjectionType (DynamoDB's own
// rule), so this is the one place search recovers the id from an INCLUDE-projected item
// that otherwise carries only `name`. The inverse of coursePk, so the prefix can never drift
// between the two.
export const courseIdFromPk = (pk: string): CourseId => courseId(pk.slice(COURSE_PK_PREFIX.length));

// gsi1's partition key is this ONE constant for every course item — a deliberate v1 choice
// (brief, M6 Task 3): search is a single Query (`gsi1pk = "COURSE" AND begins_with(gsi1sk,
// prefix)`) rather than a scatter-gather across shards, and a few thousand courses sit
// trivially inside one partition's throughput/size limits. Re-sharding (e.g. by name's first
// letter) is real future work only if beta telemetry ever shows this partition running hot —
// not a v1 concern.
export const courseGsi1pk = "COURSE";

// The core table's golfer-item key vocabulary (M7 Task 3): a Golfer aggregate is a plain CRUD
// document too (GolferStore's port comment, mirrors CourseStore) — one item, `pk` =
// golferPk(id) / `sk` fixed to GOLFER. The SAME golferPk also names a golfer's partition on
// the `projections` table below — one id, one pk format, shared across both tables.
const GOLFER_PK_PREFIX = "GOLFER#";
export const golferPk = (id: GolferId): string => `${GOLFER_PK_PREFIX}${id}`;
export const golferSk = "GOLFER";

// golferId parses back out of a gsi2-projected item's `pk`, same idiom as courseIdFromPk
// above — the inverse of golferPk, so the prefix can never drift between the two.
export const golferIdFromPk = (pk: string): GolferId => golferId(pk.slice(GOLFER_PK_PREFIX.length));

// gsi2's key vocabulary (M7 Task 3; architecture.md §3's core-table GSI list: "join code,
// cognito sub, golfer→crews") — the sub→golfer lookup getBySub queries. gsi2pk is set on a
// golfer item ONLY once a sub is bound (createDynamoGolferStore's put/bindSub) — a sub-less row
// is deliberately absent from gsi2, since no sub can look it up yet. gsi2sk is a fixed constant
// (exactly one golfer item per sub) but still a real stored attribute, not folded into gsi2pk
// alone: a GSI's sort key, like its partition key, must be present on an item for that item to
// be projected into the index at all, so both are set (or omitted) together.
export const golferGsi2pk = (sub: string): string => `SUB#${sub}`;
export const golferGsi2sk = "GOLFER";

// bindSub's atomic SUB#<sub> pointer item (M9 hardening) — a base-table item (NOT a GSI
// attribute; a different namespace than golferGsi2pk's own "SUB#<sub>" gsi2pk VALUE above,
// since pk and gsi2pk are different attributes entirely) that replaces gsi2 as getBySub's
// READ path. gsi2 is only ever eventually consistent — no DynamoDB GSI supports
// ConsistentRead — which is exactly the "known duplicate-golfer race window" this closes: two
// concurrent PUT /me calls for the SAME brand-new sub could each miss the other's
// not-yet-propagated gsi2 write and each create its OWN golfer row. This pointer item, written
// transactionally alongside the golfer row's own `sub` attribute (createDynamoGolferStore's
// bindSub), is a real base-table key — ConsistentRead-able and the actual arbiter of a
// concurrent bind race via its own attribute_not_exists(pk) condition. gsi2pk/gsi2sk are still
// WRITTEN by bindSub for rollback safety, but nothing reads them anymore.
const GOLFER_SUB_PK_PREFIX = "SUB#";
export const golferSubPk = (sub: string): string => `${GOLFER_SUB_PK_PREFIX}${sub}`;
export const golferSubSk = "GOLFER";

// The `projections` table's golfer-record key vocabulary (projection-realignment spec §3: "a
// key is an identity, time is an attribute" — replaces M7 Task 3's time-embedded
// `HISTORY#<15-digit-ms>#<roundId>` scheme): one partition per golfer (golferPk — shared
// id format with the core table's golfer item, but a different table), holding one ROUND# line
// per finalized round the golfer played, one INDEX snapshot, and LIVE# presence rows (spec §5;
// written starting realignment Task 13 — the key format lives here now so the store's shape
// changes exactly once). `lineSk`/`liveSk` embed ONLY the roundId — never finalizedAtMs — so a
// reopen-and-refinalize (a NEW finalizedAtMs for the SAME roundId) computes the SAME sk both
// times: a plain unconditional Put replaces the prior line outright, no query-then-delete
// dance. `listLines` makes no order promise (createDynamoProjectionStore.ts's own doc comment);
// every reader sorts by the `finalizedAtMs` attribute itself.
const LINE_SK_PREFIX = "ROUND#";
export const lineSk = (roundId: RoundId): string => `${LINE_SK_PREFIX}${roundId}`;
export const lineSkPrefix = LINE_SK_PREFIX;
export const projectionIndexSk = "INDEX";
const LIVE_SK_PREFIX = "LIVE#";
export const liveSk = (roundId: RoundId): string => `${LIVE_SK_PREFIX}${roundId}`;
export const liveSkPrefix = LIVE_SK_PREFIX;

// The core table's crew-item key vocabulary (M8 Task 3): a Crew, like a Course/Golfer, is a
// plain CRUD document (crew/crew.ts's own doc comment) — one root item, `pk` = crewPk(id) /
// `sk` fixed CREW, holding the WHOLE domain Crew (incl. its embedded `members` array) as the
// single source of truth `get`/`put` round-trip. One MEMBER item per roster member additionally
// exists PURELY to back `listByGolfer`'s gsi2 query (below) — it is a denormalized index, never
// read back into a Crew.
const CREW_PK_PREFIX = "CREW#";
export const crewPk = (id: CrewId): string => `${CREW_PK_PREFIX}${id}`;
export const crewSk = "CREW";

// crewId parses back out of a gsi-projected item's `pk`, same idiom as courseIdFromPk /
// golferIdFromPk above — the inverse of crewPk, so the prefix can never drift between the two.
export const crewIdFromPk = (pk: string): CrewId => crewId(pk.slice(CREW_PK_PREFIX.length));

const MEMBER_SK_PREFIX = "MEMBER#";
export const memberSk = (golferId: GolferId): string => `${MEMBER_SK_PREFIX}${golferId}`;
export const memberSkPrefix = MEMBER_SK_PREFIX;

// findByJoinCode's lookup (mirrors RoundStore.findByJoinCode) — but unlike the rounds table,
// the core table's gsi1 is ALREADY spoken for by course search's fixed "COURSE" partition
// (courseGsi1pk above), and architecture.md's M8 deploy is explicitly a no-table-change
// deploy (the plan's Task 4: "lambda-code + route additions only"), so a crew join code
// can't get its own dedicated GSI the way a round's does. Instead crews get their OWN fixed
// partition value on the SAME shared (gsi1pk, gsi1sk) String/String schema — a second
// single-partition scatter-gather index living beside courses', same v1 tradeoff
// courseGsi1pk's own doc comment already accepts (a few thousand crews trivially fits one
// partition's limits). gsi1sk is the joinCode itself (already a fixed-format, unique,
// server-minted 6-char code — nothing to normalize, same as RoundStore's own exact-match
// lookup).
export const crewGsi1pk = "CREW";

// gsi2's golfer→crews lookup (listByGolfer) reuses the SAME gsi2 golferStore.getBySub
// queries — a MEMBER item's gsi2pk is exactly golferPk(golferId) ("GOLFER#<id>"), a
// DIFFERENT namespace than a claimed golfer's own gsi2pk (golferGsi2pk(sub), "SUB#<sub>"),
// so the two never collide in the shared partition space (brief's own note). gsi2sk is
// exactly crewPk(crewId) ("CREW#<id>") — reusing the two pk-format functions directly rather
// than minting parallel gsi-specific helpers keeps the two formats from ever drifting apart.

// Crew seasons + counted rounds (architecture-realignment task-8-brief.md §4): entity data
// ABOUT the crew, living under the crew's OWN pk (crewPk) alongside its root/MEMBER items —
// a season and its counted rounds are never a projection, so unlike the DELETED block just
// below (a rebuildable ledger computed FROM rounds), there is nothing here to rebuild from;
// this key space IS the source of truth. `seasonSk` and `countedRoundSk` share the
// "SEASON#<seasonId>" prefix ON PURPOSE: one Query (begins_with(sk, "SEASON#")) walks BOTH a
// season's own item and every round entry filed under it, cheap at this scale (a crew's
// seasons + counted rounds are, per the brief, "hundreds at most"). `countedRoundSkMarker`
// ("#ROUND#") is exported so listSeasons' own client-side exclusion filter (createDynamoCrewStore
// — "does this sk belong to a counted-round entry, not a season itself") can never drift from
// the format countedRoundSk actually writes.
const SEASON_SK_PREFIX = "SEASON#";
export const seasonSk = (seasonId: string): string => `${SEASON_SK_PREFIX}${seasonId}`;
export const seasonSkPrefix = SEASON_SK_PREFIX;
export const countedRoundSkMarker = "#ROUND#";
export const countedRoundSk = (seasonId: string, roundId: RoundId): string => `${seasonSk(seasonId)}${countedRoundSkMarker}${roundId}`;
export const countedRoundSkPrefix = (seasonId: string): string => `${seasonSk(seasonId)}${countedRoundSkMarker}`;

// The `projections` table's old crew-round-contribution / season-records key vocabulary is GONE
// (architecture-realignment Task 9, spec §4/§9): crew standings are computed on read over the
// snapshots table (crews/getSeasonStandings), stored nowhere, so the projector no longer touches
// any crew keyspace. A crew's SEASON#/counted-round keys above (its OWN entity data on the core
// table) are unrelated and stay.
