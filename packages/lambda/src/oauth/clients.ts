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

// The narrow slice of Task 14's `OAuthStore` this module needs — just the client slot, typed
// against the concrete `ClientRecord` above. `getClient` already returns a PARSED `ClientRecord`
// because the store's own `parseClient` (supplied by whoever wires `createDynamoOAuthStore`,
// using `parseStoredClientRecord` below) does the "parse stored data, never cast it" work at the
// store boundary — this file doesn't re-parse what the store hands back.
export type ClientStore = Pick<OAuthStore<ClientRecord, unknown, unknown, unknown>, "putClient" | "getClient">;

export class ClientRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientRegistrationError";
  }
}

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
  return {
    clientId: obj.clientId,
    redirectUris: obj.redirectUris as string[],
    clientName: obj.clientName as string | undefined,
  };
};

// ---------------------------------------------------------------------------------------------
// redirectUriAllowed — design spec §4.3 / brief: exact match, except loopback matches
// port-agnostically (RFC 8252 §7.3 — Claude Code binds an ephemeral port it cannot predict).
// Path and host are NEVER relaxed, not even for loopback. This is the second attackable surface
// named in the brief: get this wrong and an authorization code can be redirected to a host an
// attacker controls.
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

export const redirectUriAllowed = (registeredUris: readonly string[], requestedUri: string): boolean => {
  const requested = tryParseUrl(requestedUri);
  if (!requested) return false;
  return registeredUris.some((registered) => {
    const reg = tryParseUrl(registered);
    if (!reg) return false;

    // Scheme, host and path are compared unconditionally, loopback or not — this is the "never
    // relaxed" half of the rule. `search` (the query string) is part of the registered URI too:
    // an exact match includes it.
    if (reg.protocol !== requested.protocol) return false;
    if (reg.hostname !== requested.hostname) return false;
    if (reg.pathname !== requested.pathname) return false;
    if (reg.search !== requested.search) return false;

    // Only PORT is ever relaxed, and only when both sides are one of the two loopback hosts
    // above (they're equal at this point, so checking one side is checking both).
    if (isLoopbackHost(reg.hostname)) return true;
    return reg.port === requested.port;
  });
};

// ---------------------------------------------------------------------------------------------
// DCR — RFC 7591, the deprecated fallback. `/register` parses JSON (unlike `/token`'s form
// encoding — design spec §4.3). 90-day TTL is the store's own `CLIENT_TTL_MS`
// (createDynamoOAuthStore.ts), not re-decided here.
// ---------------------------------------------------------------------------------------------

// Bounds belong on a request schema (CLAUDE.md) — this IS one: an unauthenticated POST body.
// The caps (10 redirect URIs, 200-char name) are generous-but-finite, purely to stop an
// abusive registration from writing an unbounded item; DCR's real unboundedness problem (an
// unbounded PILE of clients, not one huge client) is what the store's 90-day TTL answers.
const dcrRegistrationRequestSchema = z
  .object({
    redirect_uris: z
      .array(z.string().url())
      .min(1, "redirect_uris must contain at least one URI")
      .max(10, "redirect_uris exceeds the maximum of 10"),
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
  const record: ClientRecord = {
    clientId,
    redirectUris: body.redirectUris,
    clientName: body.clientName,
  };
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
    redirect_uris: z
      .array(z.string().url())
      .min(1, "redirect_uris must contain at least one URI")
      .max(10, "redirect_uris exceeds the maximum of 10"),
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
  return {
    clientId: result.data.client_id,
    redirectUris: result.data.redirect_uris,
    clientName: result.data.client_name,
  };
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

const isPrivateIPv6 = (address: string): boolean => {
  const value = expandIPv6(stripIPv6Brackets(address));
  if (value === 0n) return true; // :: (unspecified)
  if (value === 1n) return true; // ::1 (loopback)

  // ::ffff:0:0/96 — an IPv4-mapped address. Extract the mapped v4 and re-check it as v4, so
  // ::ffff:169.254.169.254 is caught by exactly the same rule as the bare v4 form.
  if (value >> 32n === 0xffffn) {
    const mapped = value & 0xffffffffn;
    const octets = [Number((mapped >> 24n) & 0xffn), Number((mapped >> 16n) & 0xffn), Number((mapped >> 8n) & 0xffn), Number(mapped & 0xffn)];
    return isPrivateIPv4(octets.join("."));
  }

  const top16 = Number(value >> 112n);
  if ((top16 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((top16 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local

  return false;
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

  const addresses = await resolveHost(hostname);
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

// Reads `Cache-Control` (an explicit `no-store`/`no-cache` or `max-age=N` wins) falling back to
// `Expires`, and returns 0 (do not cache) when neither header says anything — the safe default,
// since caching an uncacheable-by-its-own-say-so document for any length of time only benefits
// an attacker who wants a stale client identity to stick around.
export const cacheTtlMsFromHeaders = (headers: Headers, nowMs: number): number => {
  const cacheControl = headers.get("cache-control");
  if (cacheControl) {
    if (/(?:^|,)\s*(no-store|no-cache)\s*(?:,|$)/i.test(cacheControl)) return 0;
    const match = /max-age=(\d+)/i.exec(cacheControl);
    if (match) return Number(match[1]) * 1000;
  }
  const expires = headers.get("expires");
  if (expires) {
    const expiresMs = Date.parse(expires);
    if (!Number.isNaN(expiresMs)) return Math.max(0, expiresMs - nowMs);
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
      const response = await fetchImpl(target, { redirect: "manual", signal: controller.signal });

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

      const body = await readBodyWithCap(response, CIMD_MAX_BYTES);
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
