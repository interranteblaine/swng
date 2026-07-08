import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";

// Mirrors adapters-dynamodb's createDocumentClient (M3 Task 4): the SDK client
// construction stays inside the adapter package so lambda's composition root never
// imports an AWS SDK directly (AWS SDKs are importable only inside adapters,
// eslint.config.mjs). `endpoint` is the WS API's callback URL (`WS_ENDPOINT` env,
// wired by the composition root).
export const createManagementClient = (endpoint: string): ApiGatewayManagementApiClient => new ApiGatewayManagementApiClient({ endpoint });
