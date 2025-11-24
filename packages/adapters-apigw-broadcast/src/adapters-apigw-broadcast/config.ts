import type { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import type { ConnectionRepository, Logger } from "@swng/application";
import { ApiGatewayManagementApiClient as ApiGatewayManagementApiClientCtor } from "@aws-sdk/client-apigatewaymanagementapi";

export interface ApiGatewayBroadcastConfig {
  endpoint: string;
  region?: string;
  client?: ApiGatewayManagementApiClient;
  connectionRepo: ConnectionRepository;
  logger?: Logger;
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  with: () => noopLogger,
};

export function createApiGatewayManagementClient(args: {
  endpoint: string;
  region?: string;
}): ApiGatewayManagementApiClient {
  return new ApiGatewayManagementApiClientCtor({
    region: args.region,
    endpoint: args.endpoint,
  });
}

export function createApiGatewayBroadcastConfigFrom(args: {
  endpoint: string;
  region?: string;
  connectionRepo: ConnectionRepository;
  logger?: Logger;
  client?: ApiGatewayManagementApiClient;
}): ApiGatewayBroadcastConfig {
  return {
    endpoint: args.endpoint,
    region: args.region,
    connectionRepo: args.connectionRepo,
    logger: args.logger,
    client: args.client,
  };
}
