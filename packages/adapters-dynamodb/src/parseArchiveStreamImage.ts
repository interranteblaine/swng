import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { RoundArchive } from "@swng/domain";
import { archiveSk } from "./keys.js";

// The DynamoDB Streams NEW_IMAGE counterpart to createDynamoRoundStore.putArchive's Item
// shape (`{ pk: roundPk(id), sk: archiveSk, archive }`) — unmarshalls the low-level DynamoDB
// JSON a stream record always carries (regardless of which images StreamViewType selects)
// back into the plain `archive` attribute putArchive wrote. `image` is typed loosely
// (`Record<string, unknown>`) rather than importing `aws-lambda`'s own stream-record
// AttributeValue type here — this function's only real contract is "whatever shape a raw
// DynamoDB Streams NEW_IMAGE has," and the caller (lambda's projector entry) already has that
// typed correctly via `@types/aws-lambda`.
//
// The event source's own filter criteria (apps/infra-cdk/lib/swngStack.ts) restricts the
// projector Lambda to sk === ARCHIVE records, but this still asserts it — a record that slips
// past a misconfigured filter, or a REMOVE event (which carries no NewImage at all: archives
// are never deleted, so this would itself be anomalous), is corrupt input for a projector,
// never silently skipped (M7 Task 4 brief: "a poison record logs + rethrows").
export const parseArchiveStreamImage = (image: Record<string, unknown> | undefined): RoundArchive => {
  if (!image) {
    throw new Error("parseArchiveStreamImage: stream record has no NEW_IMAGE (a REMOVE event, or StreamViewType misconfigured)");
  }

  const item = unmarshall(image as unknown as Record<string, AttributeValue>);
  if (item["sk"] !== archiveSk) {
    throw new Error(`parseArchiveStreamImage: expected sk "${archiveSk}", got ${JSON.stringify(item["sk"])} — the event source's filter criteria should have excluded this`);
  }

  return item["archive"] as RoundArchive;
};
