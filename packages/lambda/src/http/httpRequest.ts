// The transport-agnostic shapes createDispatcher (dispatch.ts) actually reads and returns.
// Deliberately knows nothing about API Gateway, Lambda, or any other delivery mechanism — that
// knowledge lives ONLY in apiGatewayAdapter.ts, so a second delivery adapter (an MCP transport,
// say) can produce/consume these same two shapes instead of dispatch.ts growing a second,
// look-alike request type beside them.
//
// Every field below is a PRECONDITION dispatch.ts trusts without re-checking — each was a
// normalization dispatch.ts itself used to perform on the raw API Gateway event, moved into
// apiGatewayAdapter.ts's fromApiGatewayEvent by this task's extraction. A second adapter (the
// next task in this plan) MUST reproduce every one of these, or the failure is silent: a wrong
// method is a 404 from matchPath, not an error; wrong-case headers are a 401 on every
// authenticated route, not an error.
export interface HttpRequest {
  // MUST already be upper-case (e.g. "POST", never "post"). dispatch.ts compares this directly
  // against each Route's `method` (routes.ts) with no `.toUpperCase()` of its own — that
  // normalization used to live in createDispatcher and now lives ONLY in fromApiGatewayEvent.
  readonly method: string;
  // The PERCENT-ENCODED path (API Gateway's `rawPath`, stage prefix already stripped by the
  // adapter) — NOT pre-decoded. dispatch.ts's own decodePathSegments (dispatch.ts) is the one
  // place `%`-escapes get decoded, exactly once per request; an adapter that hands over an
  // already-decoded path causes a double-decode of any `%` a path segment legitimately contains.
  readonly path: string;
  // MUST already have every key lower-cased (HTTP header names are case-insensitive on the
  // wire, but this type is not — dispatch.ts's bearerToken reads `headers.authorization`
  // unconditionally, no `?? headers["Authorization"]` fallback of its own anymore).
  readonly headers: Record<string, string | undefined>;
  // Already filtered to defined values only — no key present at all means "absent," never a
  // key mapped to `undefined`. dispatch.ts reads `query[name]` straight through with no filter
  // of its own.
  readonly query: Record<string, string>;
  // Already base64-decoded (if the transport encoded it) but NOT yet JSON-parsed — dispatch.ts's
  // own readJsonBody still owns "is this valid JSON," the one part of body-handling that has
  // nothing to do with the transport it arrived over. `undefined` means no body at all (an
  // adapter should map an empty-string body to `undefined` too, matching the original
  // `!event.body` check this replaced — readJsonBody never distinguishes the two).
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
