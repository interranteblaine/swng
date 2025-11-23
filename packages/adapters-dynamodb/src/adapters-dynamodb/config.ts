import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, TranslateConfig } from "@aws-sdk/lib-dynamodb";

export interface DynamoConfig {
  tableName: string;
  docClient: DynamoDBDocumentClient;
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

export function createDynamoConfigFrom(args: {
  tableName: string;
  region?: string;
  docClient?: DynamoDBDocumentClient;
  translate?: TranslateConfig;
}): DynamoConfig {
  return {
    tableName: args.tableName,
    docClient:
      args.docClient ??
      createDynamoDocClient({ region: args.region, translate: args.translate }),
  };
}
