import type { OpId, RoundId } from "@swng/domain";

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
