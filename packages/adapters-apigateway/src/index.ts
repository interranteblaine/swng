// The package's one public interface (conventions §2) — consumers (lambda, its tests)
// import "@swng/adapters-apigateway", never a deep path.
export { createApiGatewayBroadcast } from "./createApiGatewayBroadcast.js";
export { createManagementClient } from "./createManagementClient.js";
