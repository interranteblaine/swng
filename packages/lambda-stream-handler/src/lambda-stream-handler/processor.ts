import type { DynamoDBStreamEvent } from "aws-lambda";
import type { BroadcastPort, Logger } from "@swng/application";
import { handleDomainEvent } from "@swng/application";
import { toDomainEventsFromStreamRecord } from "./toDomainEventsFromStreamRecord";

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  with: () => noopLogger,
};

export async function processStreamEventBatch(
  event: DynamoDBStreamEvent,
  deps: { broadcast: BroadcastPort; logger?: Logger }
): Promise<void> {
  const baseLogger = deps.logger ?? noopLogger;
  const { broadcast } = deps;

  for (const record of event.Records) {
    const recordLogger = baseLogger.with({
      recordId: record.eventID,
      eventName: record.eventName,
    });
    try {
      const domainEvents = toDomainEventsFromStreamRecord(record);
      // Sequentially handle events per record to preserve order
      for (const evt of domainEvents) {
        await handleDomainEvent(evt, broadcast);
      }
    } catch (err) {
      recordLogger.warn("Failed to process DynamoDB stream record", {
        err,
        record,
      });
      // Continue with the rest of the batch
    }
  }
}
