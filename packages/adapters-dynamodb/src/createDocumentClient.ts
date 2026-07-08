import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// AWS SDKs are importable only inside adapters (eslint.config.mjs) — lambda's composition
// root wires table names into the three createDynamo* factories below but must never
// import @aws-sdk/lib-dynamodb itself just to construct the client they take. This one-line
// factory is the seam: the SDK client's construction stays in this package, additive to
// Task 3's surface (M3 Task 4).
export const createDocumentClient = (): DynamoDBDocumentClient => DynamoDBDocumentClient.from(new DynamoDBClient({}));
