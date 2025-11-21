import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface DynamoConfig {
  tableName: string;
  docClient: DynamoDBDocumentClient;
}
