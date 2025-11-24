import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, TranslateConfig } from "@aws-sdk/lib-dynamodb";
import type { Logger } from "@swng/application";

export interface DynamoConfig {
  tableName: string;
  docClient: DynamoDBDocumentClient;
  logger?: Logger;
}

export interface DynamoDocClientOptions {
  region?: string;
  translate?: TranslateConfig;
}

export function createDynamoDocClient(
  opts: DynamoDocClientOptions = {}
): DynamoDBDocumentClient {
  const ddb = new DynamoDBClient({ region: opts.region });
  return DynamoDBDocumentClient.from(ddb, opts.translate);
}
