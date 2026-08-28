import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

// The MCP entry's own event↔Request/Response shim (design spec §2/§3.4): the SDK's
// `createMcpHandler` speaks web-standard fetch (`(Request) => Promise<Response>`), never
// `APIGatewayProxyEventV2` — that shape stays apiGatewayAdapter.ts's own (the `http` entry's
// dispatcher speaks the transport-agnostic `HttpRequest`/`HttpResponse`, not fetch, so the two
// adapters are siblings, not one reused for both). This is the ONLY place the translation
// happens; entries/mcp.ts touches neither the raw event nor a `Response` directly.
//
// A shim that drops a header turns every tool call into a `-32020 HeaderMismatch` (the
// transport rejects a request whose `Mcp-Method`/`Mcp-Name` headers disagree with the body it
// parsed them from) — so every header is copied through unconditionally, never a hand-picked
// subset.
export const toFetchRequest = (event: APIGatewayProxyEventV2): Request => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers)) {
    if (value !== undefined) headers.set(key, value);
  }

  // API Gateway's HTTP API strips scheme/host into `requestContext.domainName` and the `Host`
  // header both — `Host` is used here (present on every real request; `domainName` is the
  // fallback for a hand-built test event that omits it) because it is the literal value a
  // client's Origin/audience checks are keyed on. `rawQueryString` already carries the query
  // string verbatim (unlike `queryStringParameters`, which API Gateway can silently drop
  // repeated keys from) — an empty string means no query, so the `?` is omitted rather than
  // appended bare.
  const host = event.headers["host"] ?? event.headers["Host"] ?? event.requestContext.domainName;
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `https://${host}${event.rawPath}${query}`;

  // Base64-decoding is transport-specific (API Gateway's own isBase64Encoded flag), exactly the
  // same precondition apiGatewayAdapter.ts's fromApiGatewayEvent documents and applies — an
  // empty body ("") is treated the same as an absent one.
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : undefined;
  const method = event.requestContext.http.method.toUpperCase();

  // The Fetch `Request` constructor throws ("Request with GET/HEAD method cannot have body")
  // if a body is supplied alongside one of those methods — MCP's own single POST-only endpoint
  // (design spec §2) means this only ever matters for a malformed/test request, but a GET is
  // still handed through the way apiGatewayAdapter.ts's own dispatcher does, body dropped.
  const hasBody = body !== undefined && method !== "GET" && method !== "HEAD";

  return new Request(url, { method, headers, body: hasBody ? body : undefined });
};

export const fromFetchResponse = async (response: Response): Promise<APIGatewayProxyStructuredResultV2> => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    statusCode: response.status,
    headers,
    body: await response.text(),
  };
};
