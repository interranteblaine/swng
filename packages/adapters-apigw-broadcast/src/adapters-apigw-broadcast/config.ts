import type { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import type { ConnectionRepository } from "@swng/application";

export interface Logger {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

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
};
