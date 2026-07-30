import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { RoundArchive } from "@swng/domain";
import { parseStoredArchive } from "./parseStored.js";

// The DynamoDB Streams NEW_IMAGE counterpart to the snapshots table's item shape
// (`{ pk: <roundId>, finalizedAt: <ms>, archive: <RoundArchive> }`, written by
// createDynamoEventJournal's atomic finalize commit) — unmarshalls the low-level DynamoDB JSON
// a stream record always carries back into the plain `archive` attribute. `image` is typed
// loosely (`Record<string, unknown>`) rather than importing aws-lambda's own stream AttributeValue
// type here — this function's only real contract is "whatever shape a raw DynamoDB Streams
// NEW_IMAGE has," and the caller (lambda's projector entry) already has that typed via
// `@types/aws-lambda`.
//
// The snapshots table's stream needs no filter — every item on it already IS a finished round
// (unlike the rounds table's old mixed stream that required an ARCHIVE-only filter). So this
// asserts only what a snapshot record must carry: a NEW_IMAGE with an `archive` attribute. A
// record with no NewImage (a REMOVE — snapshots are never deleted, so anomalous) or with no
// `archive` is corrupt input for a projector, never silently skipped (same poison-record
// discipline as the ARCHIVE parser this replaces: log + rethrow, see createProjectorHandler).
export const parseSnapshotStreamImage = (image: Record<string, unknown> | undefined): RoundArchive => {
  if (!image) {
    throw new Error("parseSnapshotStreamImage: stream record has no NEW_IMAGE (a REMOVE event, or StreamViewType misconfigured)");
  }

  const item = unmarshall(image as unknown as Record<string, AttributeValue>);
  if (item["archive"] === undefined) {
    throw new Error("parseSnapshotStreamImage: stream record has no `archive` attribute — not a snapshot item, or a corrupt one");
  }

  // Spec 2026-07-30 §10: the archive is PARSED, not asserted — through the same
  // `parseStoredArchive` the snapshots table's own read side uses, so what the projector refuses
  // and what a standings read refuses cannot diverge. This is the strictest place for it to
  // matter: whatever gets past here lands in a golfer's permanent record. A failure is a poison
  // record by design (bisect, retry, DLQ — createProjectorHandler), which is the right answer for
  // a snapshot that isn't what it claims to be; the wrong answer was projecting it anyway.
  return parseStoredArchive("parseSnapshotStreamImage", item["archive"]);
};
