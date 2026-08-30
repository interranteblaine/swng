import { randomUUID } from "node:crypto";
import { lookup as nodeDnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { Clock } from "@swng/application";
import type { OAuthStore } from "@swng/adapters-dynamodb";

// Client resolution for the mediating authorization server (design spec §4.3, Task 16): a
// `client_id` is EITHER a URL — fetch it as a CIMD (Client ID Metadata Document), the path Claude
// and VS Code prefer — OR an opaque id registered earlier via DCR (RFC 7591, the deprecated
// fallback for a client that never learned CIMD). Both resolve to the same `ClientRecord` shape,
// so `/authorize` and `/token` never need to know which path a given client came in on.
//
// SECURITY POSTURE (read this before touching the fetch path): a CIMD `client_id` is a URL an
// UNAUTHENTICATED caller supplies, and this module fetches it. That is a textbook SSRF primitive
// — Lambda runs inside a VPC-adjacent network, so "fetch whatever URL shows up" can reach cloud
// instance metadata (169.254.169.254) or an internal service. Every fetch target here is treated
// as hostile: https only, no loopback/link-local/RFC1918 literal or DNS-resolved address, no
// cross-host redirect, a 64 KB response cap, a 5 s deadline. See `assertPublicHttpsUrl` for the
// address checks and the NAMED gap (DNS-rebinding TOCTOU) below it.

export interface ClientRecord {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly clientName?: string;
}

// The ONE place a `ClientRecord` is constructed, everywhere in this file. `clientName` is
// OMITTED (not present as a key at all) rather than set to `undefined` when absent — review
// round 1, Task 16, fix 2: `createDocumentClient.ts` builds its DynamoDB client with no
// `marshallOptions`, so `removeUndefinedValues` is `false`, and `marshall({ clientName:
// undefined })` throws. An optional `client_name` (RFC 7591) is the COMMON case, not an edge
// one, so `{ ...clientId, redirectUris, clientName: body.clientName }` broke the ordinary path.
const buildClientRecord = (clientId: string, redirectUris: readonly string[], clientName: string | undefined): ClientRecord =>
  clientName === undefined ? { clientId, redirectUris } : { clientId, redirectUris, clientName };

// The narrow slice of Task 14's `OAuthStore` this module needs — just the client slot, typed
// against the concrete `ClientRecord` above. `getClient` already returns a PARSED `ClientRecord`
// because the store's own `parseClient` (supplied by whoever wires `createDynamoOAuthStore`,
// using `parseStoredClientRecord` below) does the "parse stored data, never cast it" work at the
// store boundary — this file doesn't re-parse what the store hands back.
export type ClientStore = Pick<OAuthStore<ClientRecord, unknown, unknown, unknown>, "putClient" | "getClient">;

export class ClientRegistrationError extends Error {
  // `cause` (fix round 1, Important 1): every NETWORK-layer failure below is reported with ONE
  // fixed message so nothing about the client's host can be read back off the answer — the real
  // DNS/TLS/socket error rides here instead, for the operator's log and for nowhere else.
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClientRegistrationError";
  }
}

// THE ONE MESSAGE every network-layer CIMD failure wears — DNS resolution, connect, TLS, and a
// mid-stream abort alike (fix round 1, Important 1). It is deliberately singular and deliberately
// says nothing: `/authorize` is unauthenticated, and a caller who can tell "this host does not
// resolve from the Lambda" apart from "this host refused the connection" has a DNS oracle for
// internal names — the exact leak withholding the message was supposed to close. Distinguishing
// them here, even in a message no caller sees today, would put the oracle one careless
// `error_description` away from being live again.
const CIMD_FETCH_FAILED = "client metadata document could not be fetched";

// A raw throw from the network is a client-supplied document we could not obtain — the caller's
// input, not our fault, and therefore the same 400 every other CIMD verdict earns. A
// ClientRegistrationError raised deliberately (the size cap, the timeout's abort reason, a
// private-address refusal) passes through untouched: it already says what it means.
const asCimdFetchFailure = (error: unknown): ClientRegistrationError =>
  error instanceof ClientRegistrationError ? error : new ClientRegistrationError(CIMD_FETCH_FAILED, { cause: error });

// ---------------------------------------------------------------------------------------------
// Stored-record parsing — CLAUDE.md: "a type must not assert what the read path cannot
// guarantee — parse stored data, never cast it." Deliberately NO bounds here (max lengths,
// counts): CLAUDE.md's other rule is "bounds go on request schemas only, never on a stored/read
// schema" — this is the read side of a DCR record we already bounded on the way IN
// (`dcrRegistrationRequestSchema` below). Mirrors `parseEnvelope`'s plain-shape style in
// createDynamoOAuthStore.ts.
// ---------------------------------------------------------------------------------------------

export const parseStoredClientRecord = (raw: unknown): ClientRecord => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("stored OAuth client record is not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.clientId !== "string") {
    throw new Error("stored OAuth client record: clientId missing or not a string");
  }
  if (!Array.isArray(obj.redirectUris) || !obj.redirectUris.every((u) => typeof u === "string")) {
    throw new Error("stored OAuth client record: redirectUris missing or not a string[]");
  }
  if (obj.clientName !== undefined && typeof obj.clientName !== "string") {
    throw new Error("stored OAuth client record: clientName present but not a string");
  }
  return buildClientRecord(obj.clientId, obj.redirectUris as string[], obj.clientName as string | undefined);
};

// ---------------------------------------------------------------------------------------------
// redirectUriAllowed — design spec §4.3 / brief: exact match, except loopback matches
// port-agnostically (RFC 8252 §7.3 — Claude Code binds an ephemeral port it cannot predict).
// Path and host are NEVER relaxed, not even for loopback. This is the second attackable surface
// named in the brief: get this wrong and an authorization code can be redirected to a host an
// attacker controls.
//
// RETURNS THE CANONICAL MATCHED URI (or `undefined`), not a boolean — review round 1, Task 16,
// fix 4: the WHATWG URL parser strips ASCII tab/CR/LF before this function ever compares
// anything, so a raw caller string like "https://app.example.com/c\r\nb" and its parsed form
// "https://app.example.com/cb" compare as identical here — but a CALLER that went on to use the
// original raw string (e.g. to build a `Location:` header) would emit the un-stripped CRLF. The
// fix is at the boundary, not the parser: hand back `requested.href` — the value that was
// ACTUALLY validated — so a future `/authorize` never touches the untrusted raw string again.
// Also refuses a `redirect_uri` (or a registered URI) carrying userinfo or a fragment: RFC 6749
// §3.1.2 forbids a fragment in a redirect URI outright, and userinfo has no legitimate use here.
// ---------------------------------------------------------------------------------------------

// Exactly the two forms the brief names (`http://localhost/*`, `http://127.0.0.1/*`) plus the
// IPv6 loopback literal — NOT the whole 127.0.0.0/8 block. A client that registers
// `http://127.0.0.2/callback` gets exact (port-INCLUDED) matching like any other non-loopback
// host; widening this set is a deliberate future call, not an oversight.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const stripIPv6Brackets = (hostname: string): string => (hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname);

const isLoopbackHost = (hostname: string): boolean => LOOPBACK_HOSTS.has(stripIPv6Brackets(hostname));

const tryParseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

const hasUserinfoOrFragment = (url: URL): boolean => url.username !== "" || url.password !== "" || url.hash !== "";

export const redirectUriAllowed = (registeredUris: readonly string[], requestedUri: string): string | undefined => {
  const requested = tryParseUrl(requestedUri);
  if (!requested || hasUserinfoOrFragment(requested)) return undefined;

  // Review round 2, Task 16, fix 3: apply the SAME scheme allowlist `isAllowedRedirectUriScheme`
  // enforces at registration time. Unreachable today — both writers (DCR, CIMD) already refuse a
  // disallowed scheme before a record can exist — but this is the actual security decision
  // point a future `/authorize` feeds straight into a `Location:` header, and defence in depth
  // means this function must not depend on every future caller of `putClient`/the CIMD cache
  // having gone through this module's own writers.
  if (!isAllowedRedirectUriScheme(requestedUri)) return undefined;

  for (const registered of registeredUris) {
    const reg = tryParseUrl(registered);
    if (!reg || hasUserinfoOrFragment(reg) || !isAllowedRedirectUriScheme(registered)) continue;

    // Scheme, host and path are compared unconditionally, loopback or not — this is the "never
    // relaxed" half of the rule. `search` (the query string) is part of the registered URI too:
    // an exact match includes it.
    if (reg.protocol !== requested.protocol) continue;
    if (reg.hostname !== requested.hostname) continue;
    if (reg.pathname !== requested.pathname) continue;
    if (reg.search !== requested.search) continue;

    // Only PORT is ever relaxed, and only when both sides are one of the two loopback hosts
    // above (they're equal at this point, so checking one side is checking both).
    if (isLoopbackHost(reg.hostname) || reg.port === requested.port) {
      return requested.href; // canonical — see the block comment above for why not the raw input
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------------------------------
// DCR — RFC 7591, the deprecated fallback. `/register` parses JSON (unlike `/token`'s form
// encoding — design spec §4.3). 90-day TTL is the store's own `CLIENT_TTL_MS`
// (createDynamoOAuthStore.ts), not re-decided here.
// ---------------------------------------------------------------------------------------------

// The redirect_uri scheme allowlist — review round 1, Task 16, fix 5: `z.string().url()` alone
// accepts `javascript:`, `data:` and `file:`. https is always fine; http is fine ONLY for the two
// loopback hosts (RFC 8252 §7.3); anything else must look like a private-use URI scheme per RFC
// 8252 §7.1's reverse-DNS-style recommendation — containing a dot, and neither "http" nor
// "https" outright. THE RULE KEYS ON THE DOT, NOT ON HAVING A HOSTNAME — review round 2 caught an
// earlier version of this comment claiming the rejected schemes lack a "hostname for the consent
// page to display," which is backwards: `com.example.app:/callback` (ACCEPTED) parses with
// `hostname === ""`, while `myapp://callback` (REJECTED, no dot) parses with
// `hostname === "callback"`. This is deliberately narrower than RFC 8252 strictly requires (the
// dot is a recommendation there, not a MUST) — a simple undotted custom scheme like "myapp:" is
// refused rather than guessed at; that's a real, consciously-drawn line (recorded, not
// reconsidered, in review round 2), not an oversight.
//
// THE CONSEQUENCE FOR TASK 17: an accepted private-use URI genuinely DOES have an empty
// `hostname` (`com.example.app:/callback` above), and design spec §4.3 requires the consent page
// to display the redirect URI's hostname as the golfer's one safety signal before approving.
// Whoever builds that page must handle the empty-hostname case explicitly (e.g. falling back to
// showing the whole URI, or the scheme) rather than rendering a blank next to "you're granting
// access to:".
const isAllowedRedirectUriScheme = (raw: string): boolean => {
  const url = tryParseUrl(raw);
  if (!url) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return isLoopbackHost(url.hostname);
  const scheme = url.protocol.slice(0, -1); // strip the trailing ":" `URL.protocol` always carries
  return scheme.includes(".") && scheme !== "http" && scheme !== "https";
};

const REDIRECT_URI_SCHEME_MESSAGE = "redirect_uris must use https, loopback http, or a private-use URI scheme (RFC 8252 §7.1)";

// Review round 2, Task 16, fix 2: a redirect_uri carrying userinfo or a fragment used to pass
// registration (isAllowedRedirectUriScheme only checks the scheme) and then NEVER match anything
// at `/authorize` time, because `redirectUriAllowed` refuses userinfo/fragment on both sides.
// Fail-closed, but silently dead — the registering client believes it registered something
// usable. Refusing it HERE, at `/register`, means the client learns immediately instead of
// discovering a permanently-unmatchable URI the first time a real user tries to authorize.
const REDIRECT_URI_USERINFO_OR_FRAGMENT_MESSAGE = "redirect_uris must not contain userinfo (user:pass@) or a fragment (#...) — RFC 6749 §3.1.2";

const isFreeOfUserinfoAndFragment = (raw: string): boolean => {
  const url = tryParseUrl(raw);
  return url !== undefined && !hasUserinfoOrFragment(url);
};

// ---------------------------------------------------------------------------------------------
// `redirect_uris` — ONE schema, shared by the DCR body and the CIMD document, because the two are
// the same untrusted list arriving by two roads and a bound that lives in two places is a bound
// that will disagree with itself.
//
// Review round 2, N2-2: the count was capped and the STRINGS were not, so "10 redirect URIs"
// bounded nothing — `https://client.example.com/` plus 400 000 characters is a valid URL. Proved:
// ten 400 KB URIs threw `Item size has exceeded the maximum allowed size` out of
// `registerDcrClient`, and — the more interesting half — nine 45 450-character URIs REGISTERED
// SUCCESSFULLY and then threw the same exception at `/authorize`, because a client's
// `registeredRedirectUris` are copied verbatim into the request record. Past leg 1 that overflow
// lands after the golfer has already authenticated. It is the exact failure `/authorize`'s own
// oversized-`state` test exists to prevent, reachable through a different field.
//
// THE NUMBERS COME FROM WHAT A REDIRECT URI IS, not from what DynamoDB tolerates:
//
//   - 2048 characters each, the conventional URL ceiling and the SAME cap `authorizeQuerySchema`
//     puts on the `redirect_uri` it must match exactly — a registered URI longer than that could
//     never be redeemed at /authorize anyway, so this bound can only refuse a registration that
//     was already useless.
//   - 8 KB for the whole list, measured in BYTES (N-1's lesson: `.max()` counts UTF-16 code units,
//     and a URI may carry multi-byte characters). Real clients register one to three loopback or
//     https URIs of 30–60 characters; 8 KB is two orders of magnitude of headroom, and it is what
//     makes the guarantee hold for a LEGAL COUNT of LEGAL-LENGTH URIs — ten 2048-character URIs
//     are individually fine and together are not, which is precisely the band that overflowed.
//
// WHAT IS THEREFORE GUARANTEED (the old comment claimed this and did not deliver it): a client
// record is at most ~8.5 KB — the URI list, a 200-character name, a 36-character id — and so is
// the `registeredRedirectUris` any /authorize request record copies out of it. Both are three
// orders of magnitude under DynamoDB's 400 KB item ceiling, and no combination of a legal body
// can raise either.
// ---------------------------------------------------------------------------------------------

export const MAX_REDIRECT_URI_LENGTH = 2048;
export const MAX_REDIRECT_URIS_TOTAL_BYTES = 8 * 1024;

const redirectUrisSchema = z
  .array(
    z
      .string()
      .max(MAX_REDIRECT_URI_LENGTH, `a redirect URI exceeds the maximum of ${MAX_REDIRECT_URI_LENGTH} characters`)
      .url()
      .refine(isAllowedRedirectUriScheme, { message: REDIRECT_URI_SCHEME_MESSAGE })
      .refine(isFreeOfUserinfoAndFragment, { message: REDIRECT_URI_USERINFO_OR_FRAGMENT_MESSAGE }),
  )
  .min(1, "redirect_uris must contain at least one URI")
  .max(10, "redirect_uris exceeds the maximum of 10")
  .refine((uris) => uris.reduce((total, uri) => total + Buffer.byteLength(uri, "utf8"), 0) <= MAX_REDIRECT_URIS_TOTAL_BYTES, {
    message: `redirect_uris exceeds the maximum of ${MAX_REDIRECT_URIS_TOTAL_BYTES} bytes in total`,
  });

// Bounds belong on a request schema (CLAUDE.md) — this IS one: an unauthenticated POST body.
// The caps are generous-but-finite, purely to stop an abusive registration from writing an
// unbounded item; DCR's real unboundedness problem (an unbounded PILE of clients, not one huge
// client) is what the store's 90-day TTL answers.
const dcrRegistrationRequestSchema = z
  .object({
    redirect_uris: redirectUrisSchema,
    client_name: z.string().max(200).optional(),
  })
  .passthrough();

export const parseDcrRegistrationRequestBody = (rawJson: string): { redirectUris: string[]; clientName?: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new ClientRegistrationError("registration request body is not valid JSON");
  }
  const result = dcrRegistrationRequestSchema.safeParse(parsed);
  if (!result.success) {
    throw new ClientRegistrationError(`registration request failed validation: ${result.error.message}`);
  }
  return { redirectUris: result.data.redirect_uris, clientName: result.data.client_name };
};

export const registerDcrClient = async (
  rawJson: string,
  deps: { store: ClientStore; generateClientId?: () => string },
): Promise<ClientRecord> => {
  const body = parseDcrRegistrationRequestBody(rawJson);
  const clientId = (deps.generateClientId ?? randomUUID)();
  const record = buildClientRecord(clientId, body.redirectUris, body.clientName);
  await deps.store.putClient(clientId, record);
  return record;
};

// ---------------------------------------------------------------------------------------------
// CIMD — the modern path. §4.3: https only, no redirects into private address space, 64 KB cap,
// 5 s timeout, cached per HTTP headers, and the document's own `client_id` must equal the URL it
// was fetched from exactly.
// ---------------------------------------------------------------------------------------------

export const CIMD_MAX_BYTES = 64 * 1024;
export const CIMD_TIMEOUT_MS = 5_000;
const CIMD_MAX_REDIRECTS = 5;

// Same shape as the DCR body, minus `client_id` which the fetch loop checks separately (against
// the URL, not against itself). Bounded for the same "least trustworthy input in this codebase"
// reason the brief calls out explicitly.
const cimdDocumentSchema = z
  .object({
    client_id: z.string().max(2048),
    redirect_uris: redirectUrisSchema,
    client_name: z.string().max(200).optional(),
  })
  .passthrough();

export const parseCimdDocument = (rawBody: string, expectedClientIdUrl: string): ClientRecord => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new ClientRegistrationError("client metadata document is not valid JSON");
  }
  const result = cimdDocumentSchema.safeParse(parsed);
  if (!result.success) {
    throw new ClientRegistrationError(`client metadata document failed validation: ${result.error.message}`);
  }
  // THE identity check the CIMD model rests on: client_id IS the URL, so a document served at
  // one URL claiming to BE a different client_id would let one hostname vouch for another's
  // identity. Exact string equality against the URL that was actually fetched (the caller's
  // original `clientId`, never the post-redirect URL — see fetchCimdClient).
  if (result.data.client_id !== expectedClientIdUrl) {
    throw new ClientRegistrationError(
      `client metadata document's client_id ("${result.data.client_id}") does not match the URL it was fetched from ("${expectedClientIdUrl}")`,
    );
  }
  return buildClientRecord(result.data.client_id, result.data.redirect_uris, result.data.client_name);
};

// ---- SSRF guard -------------------------------------------------------------------------------

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

const defaultResolveHost: HostResolver = async (hostname) => {
  const results = await nodeDnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

// IPv4 private/reserved ranges relevant to SSRF (RFC 1918 + loopback + link-local, the three the
// brief names by name, plus a handful more that are real-world SSRF-relevant even though the
// brief doesn't spell them out: 0.0.0.0/8, 100.64.0.0/10 (carrier-grade NAT — some cloud metadata
// proxies live here), 192.0.0.0/24 (IETF protocol assignments), 198.18.0.0/15 (benchmarking),
// and 224.0.0.0/4 + 240.0.0.0/4 (multicast/reserved, via the `a >= 224` catch-all). This is
// deliberately NOT delegated to `node:net`'s `BlockList` — hand-verified against this runtime
// (Node 24) to mismatch IPv4-mapped-IPv6 subnets (an `addSubnet("::ffff:0.0.0.0", 96, "ipv6")`
// entry made `BlockList.check` true for EVERY IPv4 address, including public ones like 8.8.8.8) —
// a security-critical range check should not depend on an unverified stdlib corner.
const isPrivateIPv4 = (address: string): boolean => {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    throw new Error(`not a dotted-decimal IPv4 literal: ${address}`);
  }
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, INCLUDES 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4) + broadcast
  return false;
};

// Expands any legal IPv6 literal (with "::" compression and/or an embedded dotted IPv4 tail,
// e.g. "::ffff:127.0.0.1") to a single 128-bit integer, so range checks below are a handful of
// bit-shift comparisons instead of string games.
const expandIPv6 = (address: string): bigint => {
  const withoutZone = address.split("%")[0]!;
  const halves = withoutZone.includes("::") ? withoutZone.split("::") : [withoutZone];
  if (halves.length > 2) throw new Error(`not a valid IPv6 literal: ${address}`);
  const [headPart, tailPart] = halves;

  const expandEmbeddedIPv4 = (groups: string[]): string[] => {
    const last = groups.at(-1);
    if (!last || !last.includes(".")) return groups;
    const octets = last.split(".").map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      throw new Error(`not a valid embedded IPv4 tail: ${last}`);
    }
    const [o0, o1, o2, o3] = octets as [number, number, number, number];
    return [...groups.slice(0, -1), ((o0 << 8) | o1).toString(16), ((o2 << 8) | o3).toString(16)];
  };

  const headGroups = expandEmbeddedIPv4(headPart!.length === 0 ? [] : headPart!.split(":"));
  const tailGroups = tailPart === undefined ? [] : expandEmbeddedIPv4(tailPart.length === 0 ? [] : tailPart.split(":"));

  let allGroups: string[];
  if (halves.length === 1) {
    allGroups = headGroups;
  } else {
    const missing = 8 - (headGroups.length + tailGroups.length);
    if (missing < 0) throw new Error(`not a valid IPv6 literal: ${address}`);
    allGroups = [...headGroups, ...Array<string>(missing).fill("0"), ...tailGroups];
  }
  if (allGroups.length !== 8) throw new Error(`not a valid IPv6 literal: ${address}`);

  return allGroups.reduce((acc, group) => {
    const value = Number.parseInt(group === "" ? "0" : group, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new Error(`not a valid IPv6 group "${group}" in: ${address}`);
    }
    return (acc << 16n) | BigInt(value);
  }, 0n);
};

const octetsToDotted = (value: bigint): string =>
  [Number((value >> 24n) & 0xffn), Number((value >> 16n) & 0xffn), Number((value >> 8n) & 0xffn), Number(value & 0xffn)].join(".");

// ALLOWLIST, not blocklist — review round 1, Task 16, fix 1 (Critical). The prior version named
// four ranges (::, ::1, fe80::/10 link-local, fc00::/7 unique-local) plus the ::ffff:0:0/96
// IPv4-mapped delegation, and a reviewer PROBE proved `fetchImpl` was reached for six more IPv6
// forms that range simply never enumerated: NAT64 (64:ff9b::/96), 6to4 (2002::/16), deprecated
// site-local (fec0::/10), IPv4-compatible (::a.b.c.d), and IPv4-translated (::ffff:0:a.b.c.d).
// Not reachable TODAY — the CDK stack has no VPC, so there's no IPv6 egress and this module
// isn't wired yet — but NAT64 is a documented cloud-SSRF bypass class, and a blocklist that must
// enumerate every non-public range is a hole waiting for the next one IANA (or a cloud vendor)
// invents. A SECURITY CONTROL LIKE THIS MUST ENUMERATE WHAT'S PERMITTED: only `2000::/3`
// (assigned global unicast) is public, full stop. That alone silently catches every range named
// above EXCEPT one — 6to4 (2002::/16) sits INSIDE 2000::/3 by construction (it's an IANA-assigned
// /16 carved out of it) while still embedding an arbitrary, un-vetted IPv4 address in its next 32
// bits, so it gets its own explicit unwrap-and-recheck below. The IPv4-mapped case (::ffff:0:0/96,
// OUTSIDE 2000::/3) keeps its own explicit delegation to `isPrivateIPv4` for the same reason —
// both are "this IPv6 address is just packaging around an IPv4 one; judge the IPv4," not "this
// IPv6 address is itself a public network."
const isPrivateIPv6 = (address: string): boolean => {
  const value = expandIPv6(stripIPv6Brackets(address));

  // ::ffff:0:0/96 — IPv4-mapped. Extract the mapped v4 and re-check IT, so ::ffff:169.254.169.254
  // is caught by exactly the same rule as the bare v4 form (and ::ffff:8.8.8.8, a legitimately
  // public address wearing an IPv6 wrapper, is correctly let through).
  if (value >> 32n === 0xffffn) {
    return isPrivateIPv4(octetsToDotted(value & 0xffffffffn));
  }

  const top16 = Number(value >> 112n);

  // 2002::/16 (6to4, RFC 3056) embeds an IPv4 address in the NEXT 32 bits
  // (2002:V4ADDR::/48) and would otherwise sail through the 2000::/3 allowlist below
  // untouched — a reviewer probe confirmed 2002:7f00:1:: (encoding 127.0.0.1) reached
  // `fetchImpl` before this case was added. Unwrap and re-check the embedded v4 exactly like
  // the IPv4-mapped case above.
  if (top16 === 0x2002) {
    return isPrivateIPv4(octetsToDotted((value >> 80n) & 0xffffffffn));
  }

  // Every other special-purpose range (::, ::1, fe80::/10, fc00::/7, fec0::/10 deprecated
  // site-local, 64:ff9b::/96 NAT64, ::a.b.c.d deprecated IPv4-compatible, ::ffff:0:a.b.c.d
  // IPv4-translated, and anything IANA has not assigned as global unicast) falls out of this one
  // comparison for free: none of them have `001` as their top three bits.
  return (top16 & 0xe000) !== 0x2000;
};

// The one thing this module names as an HONEST GAP (task-16 brief's own instruction: name a gap
// rather than overclaim): this checks the address(es) `resolveHost` reports NOW, but the actual
// `fetch()` call performs its OWN, separate DNS resolution moments later. A DNS server an
// attacker controls can answer this check with a public IP and the follow-up fetch's resolution
// with a private one (classic "DNS rebinding"). Closing that gap fully means pinning the exact
// resolved socket address the check approved, which Node's built-in global `fetch` does not
// expose a hook for — doing it properly needs the `undici` package's `Agent`/connector API as an
// explicit new dependency, which is out of scope for this task. What IS covered: an IP literal
// client_id (any written form — decimal, octal, IPv6-mapped — `new URL(...)` already canonicalizes
// those before this function ever sees them), a hostname that resolves to a private address under
// normal (non-adversarial-DNS) conditions, and every redirect hop re-running this same check.
const assertPublicHttpsUrl = async (url: URL, resolveHost: HostResolver): Promise<void> => {
  if (url.protocol !== "https:") {
    throw new ClientRegistrationError(`client_id must use https, got "${url.protocol}//..."`);
  }

  const hostname = stripIPv6Brackets(url.hostname);
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    const isPrivate = literalFamily === 4 ? isPrivateIPv4(hostname) : isPrivateIPv6(hostname);
    if (isPrivate) {
      throw new ClientRegistrationError(`client_id resolves to a private address: ${hostname}`);
    }
    return;
  }

  // A DNS failure (`getaddrinfo ENOTFOUND`) throws a bare system Error, which — before this
  // wrap — travelled straight past the entry's `instanceof ClientRegistrationError` mapping and
  // answered 500, making the status code itself say "this hostname does not resolve here."
  let addresses: readonly string[];
  try {
    addresses = await resolveHost(hostname);
  } catch (error) {
    throw asCimdFetchFailure(error);
  }
  if (addresses.length === 0) {
    throw new ClientRegistrationError(`client_id host does not resolve to any address: ${hostname}`);
  }
  for (const address of addresses) {
    const family = isIP(address);
    if (family === 0) {
      throw new ClientRegistrationError(`client_id host resolved to a non-IP address: ${hostname} -> ${address}`);
    }
    const isPrivate = family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address);
    if (isPrivate) {
      throw new ClientRegistrationError(`client_id host resolves to a private address: ${hostname} -> ${address}`);
    }
  }
};

// ---- Caching (per the response's own HTTP headers, not a fixed TTL) --------------------------
//
// Deliberately NOT the same `ClientStore`/`putClient` Task 14 built: that store's `putClient`
// bakes in a FIXED 90-day TTL (`CLIENT_TTL_MS`), which is the right lifetime for a DCR
// registration record but the wrong one for a fetched document that may declare its own
// `Cache-Control: max-age=…` or `Expires` — using the 90-day store for CIMD would silently
// override the document's own cache lifetime. So CIMD caching is its own small port; the brief
// ties the OAuthStore explicitly to DCR only ("90-day TTL via the store from Task 14").

export interface CimdCache {
  get(clientIdUrl: string): Promise<ClientRecord | undefined>;
  set(clientIdUrl: string, record: ClientRecord, ttlMs: number): Promise<void>;
}

// Ceiling on a CIMD document's SELF-DECLARED cache lifetime — review round 1, Task 16, fix 6:
// `Number(match[1]) * 1000` with no cap let a client's own `Cache-Control: max-age=999999999`
// pin its record for over 31 years, which is effectively "this identity can never be revoked or
// re-fetched even after the domain changes hands." 24h is generous for a document that's
// supposed to be cheap to re-fetch (64 KB cap, 5s timeout) and short enough that a compromised
// or transferred domain's stale record ages out within a day rather than a decade.
export const CIMD_MAX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Reads `Cache-Control` (an explicit `no-store`/`no-cache` or `max-age=N` wins) falling back to
// `Expires`, and returns 0 (do not cache) when neither header says anything — the safe default,
// since caching an uncacheable-by-its-own-say-so document for any length of time only benefits
// an attacker who wants a stale client identity to stick around. Whatever a header DOES declare
// is clamped to `CIMD_MAX_CACHE_TTL_MS` — see above.
export const cacheTtlMsFromHeaders = (headers: Headers, nowMs: number): number => {
  const cacheControl = headers.get("cache-control");
  if (cacheControl) {
    if (/(?:^|,)\s*(no-store|no-cache)\s*(?:,|$)/i.test(cacheControl)) return 0;
    const match = /max-age=(\d+)/i.exec(cacheControl);
    if (match) return Math.min(Number(match[1]) * 1000, CIMD_MAX_CACHE_TTL_MS);
  }
  const expires = headers.get("expires");
  if (expires) {
    const expiresMs = Date.parse(expires);
    if (!Number.isNaN(expiresMs)) return Math.min(Math.max(0, expiresMs - nowMs), CIMD_MAX_CACHE_TTL_MS);
  }
  return 0;
};

const readBodyWithCap = async (response: Response, maxBytes: number): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new ClientRegistrationError(`client metadata document exceeds the ${maxBytes}-byte cap`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

export interface FetchCimdDeps {
  readonly clock: Clock;
  readonly fetchImpl?: typeof fetch;
  readonly resolveHost?: HostResolver;
  readonly cache?: CimdCache;
}

export const fetchCimdClient = async (clientIdUrl: string, deps: FetchCimdDeps): Promise<ClientRecord> => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveHost = deps.resolveHost ?? defaultResolveHost;

  const cached = await deps.cache?.get(clientIdUrl);
  if (cached) return cached;

  let target = tryParseUrl(clientIdUrl);
  if (!target) throw new ClientRegistrationError(`client_id is not a valid URL: ${clientIdUrl}`);
  await assertPublicHttpsUrl(target, resolveHost);
  const originalOrigin = target.origin;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new ClientRegistrationError("client metadata document fetch timed out")), CIMD_TIMEOUT_MS);

  try {
    for (let hop = 0; ; hop++) {
      if (hop > CIMD_MAX_REDIRECTS) {
        throw new ClientRegistrationError(`client metadata document fetch followed more than ${CIMD_MAX_REDIRECTS} redirects`);
      }

      // `redirect: "manual"` — we decide whether each hop is acceptable BEFORE this function (or
      // undici) ever opens a connection to it, rather than letting fetch silently chase a
      // redirect into private address space on our behalf.
      // Connect refused, TLS handshake failure, and every other transport fault arrive as a bare
      // `TypeError: fetch failed` — same treatment, same message, same status as everything else.
      let response: Response;
      try {
        response = await fetchImpl(target, { redirect: "manual", signal: controller.signal });
      } catch (error) {
        throw asCimdFetchFailure(error);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new ClientRegistrationError("client metadata document redirect had no Location header");
        const next = tryParseUrl(new URL(location, target).toString());
        if (!next) throw new ClientRegistrationError(`client metadata document redirect Location is not a valid URL: ${location}`);
        if (next.origin !== originalOrigin) {
          throw new ClientRegistrationError(`client metadata document fetch followed a cross-host redirect to ${next.origin}`);
        }
        await assertPublicHttpsUrl(next, resolveHost);
        target = next;
        continue;
      }

      if (!response.ok) {
        throw new ClientRegistrationError(`client metadata document fetch failed with status ${response.status}`);
      }

      // A server that drops the connection mid-body makes `reader.read()` reject with
      // `TypeError: terminated` — the third escaping class. `readBodyWithCap`'s OWN size-cap
      // refusal is already a ClientRegistrationError and passes through unchanged.
      let body: string;
      try {
        body = await readBodyWithCap(response, CIMD_MAX_BYTES);
      } catch (error) {
        throw asCimdFetchFailure(error);
      }
      const record = parseCimdDocument(body, clientIdUrl);

      if (deps.cache) {
        const ttlMs = cacheTtlMsFromHeaders(response.headers, deps.clock.now());
        if (ttlMs > 0) await deps.cache.set(clientIdUrl, record, ttlMs);
      }
      return record;
    }
  } finally {
    clearTimeout(timeout);
  }
};

// ---- resolveClient — the single entry point /authorize and /token use -------------------------

const isHttpsClientIdUrl = (clientId: string): boolean => tryParseUrl(clientId)?.protocol === "https:";

export const resolveClient = async (
  clientId: string,
  deps: { store: ClientStore; cimd: FetchCimdDeps },
): Promise<ClientRecord | undefined> => {
  if (isHttpsClientIdUrl(clientId)) {
    return fetchCimdClient(clientId, deps.cimd);
  }
  return deps.store.getClient(clientId);
};
