// The transport-agnostic shapes createDispatcher (dispatch.ts) actually reads and returns.
// Deliberately knows nothing about API Gateway, Lambda, or any other delivery mechanism — that
// knowledge lives ONLY in apiGatewayAdapter.ts, so a second delivery adapter (an MCP transport,
// say) can produce/consume these same two shapes instead of dispatch.ts growing a second,
// look-alike request type beside them.
//
// `body` is already base64-decoded (if it needed to be) but NOT yet JSON-parsed — dispatch.ts's
// own readJsonBody still owns "is this valid JSON," the one part of body-handling that has
// nothing to do with the transport it arrived over.
export interface HttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | undefined>;
  readonly query: Record<string, string>;
  readonly body: string | undefined;
}

// `statusCode` (not `status`) deliberately matches the API Gateway result shape field-for-field
// — dispatch.test.ts's ~137 `statusCode` assertions stand unchanged, and toApiGatewayResult
// (apiGatewayAdapter.ts) becomes a pure field pass-through rather than a translation.
export interface HttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}
