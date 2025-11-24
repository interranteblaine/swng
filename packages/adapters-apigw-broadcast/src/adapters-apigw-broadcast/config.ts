import type { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import type { ConnectionRepository, Logger } from "@swng/application";
import { ApiGatewayManagementApiClient as ApiGatewayManagementApiClientCtor } from "@aws-sdk/client-apigatewaymanagementapi";

export interface ApiGatewayBroadcastConfig {
  client: ApiGatewayManagementApiClient;
  connectionRepo: ConnectionRepository;
  logger?: Logger;
}

export function createApiGatewayManagementClient(args: {
  endpoint: string;
  region?: string;
}): ApiGatewayManagementApiClient {
  return new ApiGatewayManagementApiClientCtor({
    region: args.region,
    endpoint: args.endpoint,
  });
}
