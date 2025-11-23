import type {
  DynamoDBStreamEvent,
  DynamoDBStreamHandler,
  Context,
} from "aws-lambda";
import type { BroadcastPort } from "@swng/application";
import { handleDomainEvent } from "@swng/application";
import { toDomainEventsFromStreamRecord } from "./toDomainEventsFromStreamRecord";

export interface Logger {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export async function processStreamEventBatch(
  event: DynamoDBStreamEvent,
  deps: { broadcast: BroadcastPort; logger?: Logger }
): Promise<void> {
  const logger = deps.logger ?? noopLogger;
  const { broadcast } = deps;

  for (const record of event.Records) {
    try {
      const domainEvents = toDomainEventsFromStreamRecord(record);
      // Sequentially handle events per record to preserve order
      for (const evt of domainEvents) {
        await handleDomainEvent(evt, broadcast);
      }
    } catch (err) {
      logger.warn?.("Failed to process DynamoDB stream record", {
        err,
        record,
      });
      // Continue with the rest of the batch
    }
  }
}

export function createStreamHandler(deps: {
  broadcast: BroadcastPort;
  logger?: Logger;
}): DynamoDBStreamHandler {
  const logger = deps.logger ?? noopLogger;

  const handler: DynamoDBStreamHandler = async (
    event: DynamoDBStreamEvent,
    _context: Context
  ): Promise<void> => {
    await processStreamEventBatch(event, { broadcast: deps.broadcast, logger });
  };

  return handler;
}
