import type { CourseId, OpId, RoundId } from "@swng/domain";
import { courseId } from "@swng/domain";

// The rounds table's key vocabulary (M3 plan, Global Constraints): one item collection per
// round (`pk`), holding the event log (`EVT#<seq>`, sorted lexically in seq order because
// the padding fixes every sk to the same width), the mutable pointer to itself (`META`, also
// the gsi1 join-code lookup target), the terminal settlement (`ARCHIVE`), and one tombstone
// per ingested opId (`OPID#<id>`) that makes append's dedupe a plain conditional put.
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
export const archiveSk = "ARCHIVE";

export const opIdSk = (id: OpId): string => `OPID#${id}`;

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
