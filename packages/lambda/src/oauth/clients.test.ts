import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "@swng/application";
import {
  CIMD_MAX_BYTES,
  CIMD_MAX_CACHE_TTL_MS,
  MAX_REDIRECT_URI_LENGTH,
  MAX_REDIRECT_URIS_TOTAL_BYTES,
  cacheTtlMsFromHeaders,
  type CimdCache,
  type ClientRecord,
  type ClientStore,
  ClientRegistrationError,
  fetchCimdClient,
  parseCimdDocument,
  parseDcrRegistrationRequestBody,
  parseStoredClientRecord,
  redirectUriAllowed,
  registerDcrClient,
  resolveClient,
} from "./clients.js";

const fixedClock: Clock = { now: () => 1_000_000 };

// ---------------------------------------------------------------------------------------------
// redirectUriAllowed — RFC 8252 §7.3 loopback port-agnosticism, but host and path never relax.
// ---------------------------------------------------------------------------------------------

describe("redirectUriAllowed", () => {
  it("allows an exact non-loopback match, returning the canonical matched URI", () => {
    expect(redirectUriAllowed(["https://app.example.com/cb"], "https://app.example.com/cb")).toBe("https://app.example.com/cb");
  });

  it("refuses a non-loopback host with a different port", () => {
    expect(redirectUriAllowed(["https://app.example.com:443/cb"], "https://app.example.com:8443/cb")).toBeUndefined();
  });

  it("refuses a non-loopback host with a different path", () => {
    expect(redirectUriAllowed(["https://app.example.com/cb"], "https://app.example.com/other")).toBeUndefined();
  });

  it("refuses a non-loopback host that merely shares a hostname suffix", () => {
    expect(redirectUriAllowed(["https://app.example.com/cb"], "https://evil-app.example.com/cb")).toBeUndefined();
  });

  it("matches localhost loopback across different ephemeral ports, returning the REQUESTED (actual-port) URI", () => {
    expect(redirectUriAllowed(["http://localhost:51000/cb"], "http://localhost:61999/cb")).toBe("http://localhost:61999/cb");
  });

  it("matches 127.0.0.1 loopback across different ephemeral ports", () => {
    expect(redirectUriAllowed(["http://127.0.0.1:51000/cb"], "http://127.0.0.1:61999/cb")).toBe("http://127.0.0.1:61999/cb");
  });

  it("still refuses a loopback redirect whose PATH differs — port-agnostic never means path-agnostic", () => {
    expect(redirectUriAllowed(["http://127.0.0.1:51000/cb"], "http://127.0.0.1:61999/steal")).toBeUndefined();
  });

  it("still refuses a loopback-looking HOST that is not the registered loopback host", () => {
    // 127.0.0.2 is not in the registered set and is not string-equal to 127.0.0.1 — host is
    // never relaxed, so this must NOT be treated as "the same loopback host, different port."
    expect(redirectUriAllowed(["http://127.0.0.1:51000/cb"], "http://127.0.0.2:51000/cb")).toBeUndefined();
  });

  it("refuses an attacker-controlled redirect_uri entirely absent from the registered set", () => {
    expect(redirectUriAllowed(["https://app.example.com/cb"], "https://attacker.example/cb")).toBeUndefined();
  });

  it("refuses a malformed requested URI rather than throwing", () => {
    expect(redirectUriAllowed(["https://app.example.com/cb"], "not-a-url")).toBeUndefined();
  });

  it("returns the CANONICAL (CRLF-stripped) form, never the raw attacker-suppliable string — review round 1 fix 4", () => {
    // The WHATWG URL parser silently strips ASCII tab/CR/LF while parsing, so the raw requested
    // string below and "https://app.example.com/cb" compare as identical paths here. The point
    // of returning a value (not a boolean) is that a caller building a `Location:` header uses
    // THIS canonical string, never re-touching the original raw one.
    const result = redirectUriAllowed(["https://app.example.com/cb"], "https://app.example.com/c\r\nb");
    expect(result).toBe("https://app.example.com/cb");
    expect(result).not.toContain("\r");
    expect(result).not.toContain("\n");
  });

  it("refuses a requested redirect_uri carrying userinfo", () => {
    expect(redirectUriAllowed(["https://app.example.com/cb"], "https://user:pass@app.example.com/cb")).toBeUndefined();
  });

  it("refuses a requested redirect_uri carrying a fragment (RFC 6749 §3.1.2)", () => {
    expect(redirectUriAllowed(["https://app.example.com/cb"], "https://app.example.com/cb#frag")).toBeUndefined();
  });

  it("refuses a match against a REGISTERED uri that (somehow) carries userinfo or a fragment, even with a clean requested uri", () => {
    expect(redirectUriAllowed(["https://user@app.example.com/cb"], "https://app.example.com/cb")).toBeUndefined();
    expect(redirectUriAllowed(["https://app.example.com/cb#frag"], "https://app.example.com/cb")).toBeUndefined();
  });

  // Review round 2, Task 16, fix 3 — defence in depth: apply the SAME scheme allowlist the
  // writers (DCR, CIMD) enforce, right here too. Both a disallowed-scheme REQUESTED uri and a
  // disallowed-scheme REGISTERED uri (the latter shouldn't exist given the writers, but this
  // function must not depend on that) are refused.
  it("refuses a disallowed-scheme requested uri even if it happens to string-match a registered one", () => {
    expect(redirectUriAllowed(["javascript:alert(1)"], "javascript:alert(1)")).toBeUndefined();
  });

  it("refuses a match against a disallowed-scheme REGISTERED uri", () => {
    expect(redirectUriAllowed(["data:text/html,hi"], "data:text/html,hi")).toBeUndefined();
  });

  it("still allows a private-use (RFC 8252 §7.1) custom scheme through, matching the writers' own allowance", () => {
    expect(redirectUriAllowed(["com.example.app:/callback"], "com.example.app:/callback")).toBe("com.example.app:/callback");
  });
});

// ---------------------------------------------------------------------------------------------
// CIMD
// ---------------------------------------------------------------------------------------------

const cimdDoc = (clientId: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ client_id: clientId, redirect_uris: ["https://app.example.com/cb"], ...extra });

const jsonResponse = (body: string, init: ResponseInit = {}): Response =>
  new Response(body, { status: 200, headers: { "content-type": "application/json" }, ...init });

const redirectResponse = (location: string): Response => new Response(null, { status: 302, headers: { location } });

const publicResolveHost = async (_hostname: string): Promise<string[]> => ["93.184.216.34"];

describe("parseCimdDocument", () => {
  it("rejects a document whose client_id does not equal the URL it was fetched from", () => {
    expect(() => parseCimdDocument(cimdDoc("https://attacker.example/id"), "https://app.example.com/id")).toThrow(ClientRegistrationError);
  });

  it("accepts a document whose client_id equals the fetch URL", () => {
    const record = parseCimdDocument(cimdDoc("https://app.example.com/id"), "https://app.example.com/id");
    expect(record.clientId).toBe("https://app.example.com/id");
    expect(record.redirectUris).toEqual(["https://app.example.com/cb"]);
  });

  it("rejects a document that is not JSON", () => {
    expect(() => parseCimdDocument("not json", "https://app.example.com/id")).toThrow(ClientRegistrationError);
  });

  it("rejects a document missing redirect_uris", () => {
    expect(() => parseCimdDocument(JSON.stringify({ client_id: "https://app.example.com/id" }), "https://app.example.com/id")).toThrow(
      ClientRegistrationError,
    );
  });

  // Review round 1, Task 16, fix 5 — `z.string().url()` alone accepts `javascript:`/`data:`/
  // `file:`; none of them contain a dot before the scheme's ":", so none pass the RFC 8252 §7.1
  // private-use-scheme check (review round 2 fix 1: the rule keys on the dot, NOT on whether the
  // scheme has a "hostname" — see clients.ts's corrected comment on isAllowedRedirectUriScheme).
  it.each(["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd"])(
    "rejects a document whose redirect_uris uses a disallowed scheme (%s)",
    (badUri) => {
      expect(() => parseCimdDocument(cimdDoc("https://app.example.com/id", { redirect_uris: [badUri] }), "https://app.example.com/id")).toThrow(
        ClientRegistrationError,
      );
    },
  );

  it("accepts a loopback http redirect_uri", () => {
    const record = parseCimdDocument(
      cimdDoc("https://app.example.com/id", { redirect_uris: ["http://127.0.0.1:51000/cb"] }),
      "https://app.example.com/id",
    );
    expect(record.redirectUris).toEqual(["http://127.0.0.1:51000/cb"]);
  });

  it("accepts a private-use (reverse-DNS) custom-scheme redirect_uri", () => {
    const record = parseCimdDocument(
      cimdDoc("https://app.example.com/id", { redirect_uris: ["com.example.app:/callback"] }),
      "https://app.example.com/id",
    );
    expect(record.redirectUris).toEqual(["com.example.app:/callback"]);
  });

  it("rejects a NON-loopback http redirect_uri", () => {
    expect(() =>
      parseCimdDocument(cimdDoc("https://app.example.com/id", { redirect_uris: ["http://app.example.com/cb"] }), "https://app.example.com/id"),
    ).toThrow(ClientRegistrationError);
  });

  // Review round 2, Task 16, fix 2 — a redirect_uri with userinfo or a fragment used to register
  // successfully and then never match anything at /authorize (redirectUriAllowed refuses both on
  // either side), a silently-dead registration. Refuse it at registration time instead.
  it("rejects a redirect_uri carrying userinfo", () => {
    expect(() =>
      parseCimdDocument(
        cimdDoc("https://app.example.com/id", { redirect_uris: ["https://user:pass@app.example.com/cb"] }),
        "https://app.example.com/id",
      ),
    ).toThrow(ClientRegistrationError);
  });

  it("rejects a redirect_uri carrying a fragment", () => {
    expect(() =>
      parseCimdDocument(
        cimdDoc("https://app.example.com/id", { redirect_uris: ["https://app.example.com/cb#frag"] }),
        "https://app.example.com/id",
      ),
    ).toThrow(ClientRegistrationError);
  });
});

describe("fetchCimdClient — SSRF protection", () => {
  it("refuses a non-https client_id", async () => {
    const fetchImpl = vi.fn();
    await expect(fetchCimdClient("http://app.example.com/id", { clock: fixedClock, fetchImpl, resolveHost: publicResolveHost })).rejects.toThrow(
      ClientRegistrationError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an http-only scheme even when the host would otherwise be public", async () => {
    await expect(
      fetchCimdClient("ftp://app.example.com/id", { clock: fixedClock, fetchImpl: vi.fn(), resolveHost: publicResolveHost }),
    ).rejects.toThrow(ClientRegistrationError);
  });

  it("refuses a loopback IP literal", async () => {
    await expect(
      fetchCimdClient("https://127.0.0.1/id", { clock: fixedClock, fetchImpl: vi.fn(), resolveHost: publicResolveHost }),
    ).rejects.toThrow(ClientRegistrationError);
  });

  it("refuses a decimal-encoded loopback IP literal (127.0.0.1 == 2130706433)", async () => {
    await expect(
      fetchCimdClient("https://2130706433/id", { clock: fixedClock, fetchImpl: vi.fn(), resolveHost: publicResolveHost }),
    ).rejects.toThrow(ClientRegistrationError);
  });

  it("refuses an octal-encoded loopback IP literal (127.0.0.1 == 0177.0.0.1)", async () => {
    await expect(
      fetchCimdClient("https://0177.0.0.1/id", { clock: fixedClock, fetchImpl: vi.fn(), resolveHost: publicResolveHost }),
    ).rejects.toThrow(ClientRegistrationError);
  });

  it("refuses an IPv6-mapped IPv4 loopback literal", async () => {
    await expect(
      fetchCimdClient("https://[::ffff:127.0.0.1]/id", { clock: fixedClock, fetchImpl: vi.fn(), resolveHost: publicResolveHost }),
    ).rejects.toThrow(ClientRegistrationError);
  });

  it("refuses the bracketed IPv6 loopback literal [::1]", async () => {
    await expect(
      fetchCimdClient("https://[::1]/id", { clock: fixedClock, fetchImpl: vi.fn(), resolveHost: publicResolveHost }),
    ).rejects.toThrow(ClientRegistrationError);
  });

  // Review round 1, Task 16, fix 1 (Critical) — a reviewer PROBE confirmed `fetchImpl` was
  // invoked (i.e. the SSRF gate was bypassed) for every one of the six IPv6 forms below, against
  // the prior blocklist-of-four-ranges implementation. `isPrivateIPv6` is now an allowlist
  // (only 2000::/3 global unicast is public); these are its falsifying tests.
  it("refuses NAT64 (64:ff9b::/96) encoding a private v4 address (10.0.0.5)", async () => {
    await expect(
      fetchCimdClient("https://[64:ff9b::a00:5]/id", { clock: fixedClock, fetchImpl: vi.fn(), resolveHost: publicResolveHost }),
    ).rejects.toThrow(ClientRegistrationError);
  });

  it("refuses NAT64 (64:ff9b::/96) encoding loopback (127.0.0.1)", async () => {
    await expect(
      fetchCimdClient("https://[64:ff9b::7f00:1]/id", { clock: fixedClock, fetchImpl: vi.fn(), resolveHost: publicResolveHost }),
    ).rejects.toThrow(ClientRegistrationError);
  });

  it("refuses 6to4 (2002::/16) encoding loopback (127.0.0.1) — sits INSIDE the 2000::/3 allowlist by construction", async () => {
    await expect(
      fetchCimdClient("https://[2002:7f00:1::]/id", { clock: fixedClock, fetchImpl: vi.fn(), resolveHost: publicResolveHost }),
    ).rejects.toThrow(ClientRegistrationError);
  });

  it("refuses deprecated site-local (fec0::/10)", async () => {
    await expect(
      fetchCimdClient("https://[fec0::1]/id", { clock: fixedClock, fetchImpl: vi.fn(), resolveHost: publicResolveHost }),
    ).rejects.toThrow(ClientRegistrationError);
  });

  it("refuses deprecated IPv4-compatible (::127.0.0.1)", async () => {
    await expect(
      fetchCimdClient("https://[::127.0.0.1]/id", { clock: fixedClock, fetchImpl: vi.fn(), resolveHost: publicResolveHost }),
    ).rejects.toThrow(ClientRegistrationError);
  });

  it("refuses IPv4-translated (::ffff:0:127.0.0.1)", async () => {
    await expect(
      fetchCimdClient("https://[::ffff:0:127.0.0.1]/id", { clock: fixedClock, fetchImpl: vi.fn(), resolveHost: publicResolveHost }),
    ).rejects.toThrow(ClientRegistrationError);
  });

  it("allows a genuine global-unicast IPv6 literal — the allowlist must not over-block", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(cimdDoc("https://[2606:4700:4700::1111]/id")));
    const record = await fetchCimdClient("https://[2606:4700:4700::1111]/id", { clock: fixedClock, fetchImpl, resolveHost: publicResolveHost });
    expect(record.clientId).toBe("https://[2606:4700:4700::1111]/id");
  });

  it("allows a public IPv4-mapped IPv6 literal (::ffff:8.8.8.8) — the mapped-v4 delegation must not over-block", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(cimdDoc("https://[::ffff:8.8.8.8]/id")));
    const record = await fetchCimdClient("https://[::ffff:8.8.8.8]/id", { clock: fixedClock, fetchImpl, resolveHost: publicResolveHost });
    expect(record.clientId).toBe("https://[::ffff:8.8.8.8]/id");
  });

  it("refuses the link-local range, including the cloud instance-metadata address 169.254.169.254", async () => {
    await expect(
      fetchCimdClient("https://169.254.169.254/id", { clock: fixedClock, fetchImpl: vi.fn(), resolveHost: publicResolveHost }),
    ).rejects.toThrow(ClientRegistrationError);
  });

  it("refuses an RFC1918 IP literal (10.x)", async () => {
    await expect(
      fetchCimdClient("https://10.0.0.5/id", { clock: fixedClock, fetchImpl: vi.fn(), resolveHost: publicResolveHost }),
    ).rejects.toThrow(ClientRegistrationError);
  });

  it("refuses an RFC1918 IP literal (192.168.x)", async () => {
    await expect(
      fetchCimdClient("https://192.168.1.1/id", { clock: fixedClock, fetchImpl: vi.fn(), resolveHost: publicResolveHost }),
    ).rejects.toThrow(ClientRegistrationError);
  });

  it("refuses a hostname that RESOLVES to a private address", async () => {
    const resolveHost = async (hostname: string) => (hostname === "internal.example.com" ? ["10.0.0.9"] : ["93.184.216.34"]);
    await expect(fetchCimdClient("https://internal.example.com/id", { clock: fixedClock, fetchImpl: vi.fn(), resolveHost })).rejects.toThrow(
      ClientRegistrationError,
    );
  });

  it("refuses a redirect that lands in private address space after an allowed first hop", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://app.example.com/id") return redirectResponse("https://app.example.com/internal-redirect");
      throw new Error(`unexpected fetch to ${url}`);
    });
    // Second hop is same-origin (passes the cross-host check) but its DNS resolves privately.
    const resolveHost = async (hostname: string) => (hostname === "app.example.com" ? ["10.1.2.3"] : ["93.184.216.34"]);
    await expect(fetchCimdClient("https://app.example.com/id", { clock: fixedClock, fetchImpl, resolveHost })).rejects.toThrow(
      ClientRegistrationError,
    );
  });

  it("refuses a cross-host redirect even when the redirect target is itself public", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://app.example.com/id") return redirectResponse("https://attacker.example/id");
      throw new Error(`unexpected fetch to ${url}`);
    });
    await expect(
      fetchCimdClient("https://app.example.com/id", { clock: fixedClock, fetchImpl, resolveHost: publicResolveHost }),
    ).rejects.toThrow(ClientRegistrationError);
  });

  it("follows a SAME-host redirect and succeeds", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://app.example.com/id") return redirectResponse("https://app.example.com/id-canonical");
      if (url === "https://app.example.com/id-canonical") return jsonResponse(cimdDoc("https://app.example.com/id"));
      throw new Error(`unexpected fetch to ${url}`);
    });
    const record = await fetchCimdClient("https://app.example.com/id", { clock: fixedClock, fetchImpl, resolveHost: publicResolveHost });
    expect(record.clientId).toBe("https://app.example.com/id");
  });

  it("enforces the 64 KB response cap — with a body that is otherwise VALID and would parse (review round 1 fix 3)", () => {
    // The oversized body deliberately IS a well-formed, schema-valid CIMD document (not "x"
    // repeated, which parseCimdDocument would reject as invalid JSON regardless of the cap and
    // give this test zero falsifiability — removing the cap check must be the only thing that
    // flips this test, not a coincidental JSON-parse failure).
    const oversizedButValid = cimdDoc("https://app.example.com/id", { extra_field: "a".repeat(CIMD_MAX_BYTES + 1000) });
    expect(oversizedButValid.length).toBeGreaterThan(CIMD_MAX_BYTES);
    expect(() => JSON.parse(oversizedButValid)).not.toThrow();
    const fetchImpl = vi.fn(async () => jsonResponse(oversizedButValid));
    return expect(
      fetchCimdClient("https://app.example.com/id", { clock: fixedClock, fetchImpl, resolveHost: publicResolveHost }),
    ).rejects.toThrow(ClientRegistrationError);
  });

  it("accepts a response at or under the 64 KB cap", async () => {
    // Pad the JSON (in an unvalidated passthrough field, so the padding itself isn't what's
    // under test) so it sits close to the cap without going over.
    const padding = "a".repeat(CIMD_MAX_BYTES - 300);
    const fetchImpl = vi.fn(async () => jsonResponse(cimdDoc("https://app.example.com/id", { extra_field: padding })));
    const record = await fetchCimdClient("https://app.example.com/id", { clock: fixedClock, fetchImpl, resolveHost: publicResolveHost });
    expect(record.clientId).toBe("https://app.example.com/id");
  });

  it("times out after 5 seconds against a fetch that never resolves", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_input: unknown, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      });
      const promise = fetchCimdClient("https://app.example.com/id", { clock: fixedClock, fetchImpl: fetchImpl as unknown as typeof fetch, resolveHost: publicResolveHost });
      const assertion = expect(promise).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(5_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a fetch failure (non-2xx, non-redirect) as a ClientRegistrationError", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(fetchCimdClient("https://app.example.com/id", { clock: fixedClock, fetchImpl, resolveHost: publicResolveHost })).rejects.toThrow(
      ClientRegistrationError,
    );
  });
});

describe("fetchCimdClient — caching per the response's own headers", () => {
  const makeCache = (): CimdCache & { store: Map<string, ClientRecord> } => {
    const store = new Map<string, ClientRecord>();
    return {
      store,
      get: async (url) => store.get(url),
      set: async (url, record) => {
        store.set(url, record);
      },
    };
  };

  it("caches when the response advertises a positive max-age", async () => {
    const cache = makeCache();
    const fetchImpl = vi.fn(async () => jsonResponse(cimdDoc("https://app.example.com/id"), { headers: { "cache-control": "max-age=3600" } }));
    await fetchCimdClient("https://app.example.com/id", { clock: fixedClock, fetchImpl, resolveHost: publicResolveHost, cache });
    expect(cache.store.has("https://app.example.com/id")).toBe(true);

    // Second call is served from cache — fetch is not called again.
    await fetchCimdClient("https://app.example.com/id", { clock: fixedClock, fetchImpl, resolveHost: publicResolveHost, cache });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not cache when the response says no-store", async () => {
    const cache = makeCache();
    const fetchImpl = vi.fn(async () => jsonResponse(cimdDoc("https://app.example.com/id"), { headers: { "cache-control": "no-store" } }));
    await fetchCimdClient("https://app.example.com/id", { clock: fixedClock, fetchImpl, resolveHost: publicResolveHost, cache });
    expect(cache.store.has("https://app.example.com/id")).toBe(false);
  });

  it("does not cache when no cache header is present at all", async () => {
    const cache = makeCache();
    const fetchImpl = vi.fn(async () => jsonResponse(cimdDoc("https://app.example.com/id")));
    await fetchCimdClient("https://app.example.com/id", { clock: fixedClock, fetchImpl, resolveHost: publicResolveHost, cache });
    expect(cache.store.has("https://app.example.com/id")).toBe(false);
  });
});

describe("cacheTtlMsFromHeaders", () => {
  it("reads max-age", () => {
    expect(cacheTtlMsFromHeaders(new Headers({ "cache-control": "max-age=60" }), 0)).toBe(60_000);
  });

  it("treats no-cache as uncacheable", () => {
    expect(cacheTtlMsFromHeaders(new Headers({ "cache-control": "no-cache" }), 0)).toBe(0);
  });

  it("falls back to Expires when Cache-Control is absent", () => {
    const nowMs = Date.parse("2026-01-01T00:00:00Z");
    const ttl = cacheTtlMsFromHeaders(new Headers({ expires: "2026-01-01T00:01:00Z" }), nowMs);
    expect(ttl).toBe(60_000);
  });

  it("defaults to 0 (no cache) when neither header is present", () => {
    expect(cacheTtlMsFromHeaders(new Headers(), 0)).toBe(0);
  });

  it("clamps an absurd self-declared max-age to CIMD_MAX_CACHE_TTL_MS — review round 1 fix 6", () => {
    // A client's own document controls this header; an unclamped max-age lets it pin its
    // record for decades with no way to revoke or re-fetch it.
    const ttl = cacheTtlMsFromHeaders(new Headers({ "cache-control": "max-age=999999999" }), 0);
    expect(ttl).toBe(CIMD_MAX_CACHE_TTL_MS);
    expect(ttl).toBeLessThan(999_999_999 * 1000);
  });

  it("clamps an absurd Expires value to CIMD_MAX_CACHE_TTL_MS", () => {
    const nowMs = Date.parse("2026-01-01T00:00:00Z");
    const ttl = cacheTtlMsFromHeaders(new Headers({ expires: "2099-01-01T00:00:00Z" }), nowMs);
    expect(ttl).toBe(CIMD_MAX_CACHE_TTL_MS);
  });
});

// ---------------------------------------------------------------------------------------------
// DCR
// ---------------------------------------------------------------------------------------------

describe("parseDcrRegistrationRequestBody", () => {
  it("parses a JSON body, not form-encoded (unlike /token)", () => {
    const body = JSON.stringify({ redirect_uris: ["https://app.example.com/cb"], client_name: "Test Client" });
    const parsed = parseDcrRegistrationRequestBody(body);
    expect(parsed).toEqual({ redirectUris: ["https://app.example.com/cb"], clientName: "Test Client" });
  });

  it("rejects a form-encoded body", () => {
    expect(() => parseDcrRegistrationRequestBody("redirect_uris=https%3A%2F%2Fapp.example.com%2Fcb")).toThrow(ClientRegistrationError);
  });

  it("rejects a body with no redirect_uris", () => {
    expect(() => parseDcrRegistrationRequestBody(JSON.stringify({}))).toThrow(ClientRegistrationError);
  });

  it("rejects a body whose redirect_uris is an empty array", () => {
    expect(() => parseDcrRegistrationRequestBody(JSON.stringify({ redirect_uris: [] }))).toThrow(ClientRegistrationError);
  });

  it.each(["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd"])(
    "rejects a redirect_uris entry using a disallowed scheme (%s) — review round 1 fix 5",
    (badUri) => {
      expect(() => parseDcrRegistrationRequestBody(JSON.stringify({ redirect_uris: [badUri] }))).toThrow(ClientRegistrationError);
    },
  );

  it("accepts a loopback http redirect_uri", () => {
    const parsed = parseDcrRegistrationRequestBody(JSON.stringify({ redirect_uris: ["http://127.0.0.1:51000/cb"] }));
    expect(parsed.redirectUris).toEqual(["http://127.0.0.1:51000/cb"]);
  });

  it("accepts a private-use (reverse-DNS) custom-scheme redirect_uri", () => {
    const parsed = parseDcrRegistrationRequestBody(JSON.stringify({ redirect_uris: ["com.example.app:/callback"] }));
    expect(parsed.redirectUris).toEqual(["com.example.app:/callback"]);
  });

  it("rejects a NON-loopback http redirect_uri", () => {
    expect(() => parseDcrRegistrationRequestBody(JSON.stringify({ redirect_uris: ["http://app.example.com/cb"] }))).toThrow(
      ClientRegistrationError,
    );
  });

  // Review round 2, Task 16, fix 2 — same rationale as the CIMD tests above: a redirect_uri
  // carrying userinfo or a fragment could never match at /authorize, so DCR now refuses it at
  // registration time rather than accepting a permanently-unmatchable URI silently.
  it("rejects a redirect_uri carrying userinfo", () => {
    expect(() => parseDcrRegistrationRequestBody(JSON.stringify({ redirect_uris: ["https://user:pass@app.example.com/cb"] }))).toThrow(
      ClientRegistrationError,
    );
  });

  it("rejects a redirect_uri carrying a fragment", () => {
    expect(() => parseDcrRegistrationRequestBody(JSON.stringify({ redirect_uris: ["https://app.example.com/cb#frag"] }))).toThrow(
      ClientRegistrationError,
    );
  });
});

describe("registerDcrClient", () => {
  const makeStore = (): ClientStore & { putClient: ReturnType<typeof vi.fn>; getClient: ReturnType<typeof vi.fn> } => ({
    putClient: vi.fn(async () => undefined),
    getClient: vi.fn(async () => undefined),
  });

  it("stores the registered client and returns it", async () => {
    const store = makeStore();
    const body = JSON.stringify({ redirect_uris: ["https://app.example.com/cb"], client_name: "Test Client" });
    const record = await registerDcrClient(body, { store, generateClientId: () => "fixed-client-id" });
    expect(record).toStrictEqual({ clientId: "fixed-client-id", redirectUris: ["https://app.example.com/cb"], clientName: "Test Client" });
    expect(store.putClient).toHaveBeenCalledWith("fixed-client-id", record);
  });

  it("OMITS the clientName key entirely when absent — never an explicit `clientName: undefined` (review round 1 fix 2)", async () => {
    // `toEqual`/`toStrictEqual` alone would not have caught this — jest/vitest's `toEqual`
    // treats `{ clientName: undefined }` and `{}` as equal, which is exactly why the ORIGINAL
    // version of this test (asserting `toEqual({ ..., clientName: undefined })`) passed while
    // silently locking in a shape that throws once real DynamoDB marshalling touches it
    // (createDocumentClient.ts sets no `marshallOptions`, so `removeUndefinedValues` is `false`
    // and `marshall({ clientName: undefined })` throws — the COMMON case, since `client_name` is
    // optional in RFC 7591). `toStrictEqual` distinguishes an absent key from an explicit
    // `undefined` value, and the explicit `hasOwnProperty` checks below make the point undeniable.
    const store = makeStore();
    const body = JSON.stringify({ redirect_uris: ["https://app.example.com/cb"] });
    const record = await registerDcrClient(body, { store, generateClientId: () => "id" });
    expect(record).toStrictEqual({ clientId: "id", redirectUris: ["https://app.example.com/cb"] });
    expect(Object.hasOwn(record, "clientName")).toBe(false);
    const storedValue = (store.putClient as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.hasOwn(storedValue, "clientName")).toBe(false);
  });

  // fix round 3, N2-2: the count was capped and the strings were not, so a registration wrote an
  // UNBOUNDED item. Proved by the reviewer against real DynamoDB: ten 400 KB URIs threw
  // `Item size has exceeded the maximum allowed size`, and nine 45 450-character URIs registered
  // SUCCESSFULLY and then threw the same exception at /authorize, which copies a client's
  // registeredRedirectUris verbatim into its request record. Each of these must be refused before
  // `putClient` is ever reached — the store call is what the assertions below pin.
  const longUri = (chars: number): string => {
    const prefix = "https://client.example.com/";
    return prefix + "a".repeat(chars - prefix.length);
  };

  it("refuses a single redirect URI longer than a URL has any business being, without storing anything", async () => {
    const store = makeStore();
    const body = JSON.stringify({ redirect_uris: [longUri(MAX_REDIRECT_URI_LENGTH + 1)] });
    await expect(registerDcrClient(body, { store, generateClientId: () => "id" })).rejects.toThrow(ClientRegistrationError);
    expect(store.putClient).not.toHaveBeenCalled();
  });

  it("accepts a redirect URI at exactly the per-URI maximum — the bound is inclusive", async () => {
    const store = makeStore();
    const body = JSON.stringify({ redirect_uris: [longUri(MAX_REDIRECT_URI_LENGTH)] });
    await registerDcrClient(body, { store, generateClientId: () => "id" });
    expect(store.putClient).toHaveBeenCalled();
  });

  it("refuses a LEGAL COUNT of LEGAL-LENGTH URIs that together overflow the aggregate", async () => {
    // The chained band a per-URI cap alone misses: ten URIs, each inside the per-URI maximum, and
    // 20 KB between them. This is the shape that registered cleanly and then killed /authorize.
    const store = makeStore();
    const uris = Array.from({ length: 10 }, (_unused, index) => `${longUri(MAX_REDIRECT_URI_LENGTH - 4)}?i=${index}`);
    expect(uris.every((uri) => uri.length <= MAX_REDIRECT_URI_LENGTH)).toBe(true);
    expect(uris.reduce((total, uri) => total + uri.length, 0)).toBeGreaterThan(MAX_REDIRECT_URIS_TOTAL_BYTES);

    const body = JSON.stringify({ redirect_uris: uris });
    await expect(registerDcrClient(body, { store, generateClientId: () => "id" })).rejects.toThrow(ClientRegistrationError);
    expect(store.putClient).not.toHaveBeenCalled();
  });

  it("measures the aggregate in BYTES, not characters", async () => {
    // N-1's lesson applied to the same file: three URIs of 2000 multi-byte characters are 6000
    // code units (inside the 8 KB budget if you count wrong) and ~18 KB of UTF-8 (outside it).
    const store = makeStore();
    const multibyteUri = `https://client.example.com/${"\u8a9e".repeat(1973)}`;
    expect(multibyteUri.length).toBeLessThanOrEqual(MAX_REDIRECT_URI_LENGTH);
    const uris = [multibyteUri, `${multibyteUri}x`, `${multibyteUri}y`];
    expect(uris.reduce((total, uri) => total + uri.length, 0)).toBeLessThan(MAX_REDIRECT_URIS_TOTAL_BYTES);
    expect(uris.reduce((total, uri) => total + Buffer.byteLength(uri, "utf8"), 0)).toBeGreaterThan(MAX_REDIRECT_URIS_TOTAL_BYTES);

    const body = JSON.stringify({ redirect_uris: uris });
    await expect(registerDcrClient(body, { store, generateClientId: () => "id" })).rejects.toThrow(ClientRegistrationError);
    expect(store.putClient).not.toHaveBeenCalled();
  });

  it("still registers what a real client actually sends", async () => {
    // The regression guard for every bound above: Claude Code registers one or two loopback URIs.
    const store = makeStore();
    const body = JSON.stringify({ redirect_uris: ["http://127.0.0.1:51000/callback", "http://localhost:51000/callback"], client_name: "Claude Code" });
    const record = await registerDcrClient(body, { store, generateClientId: () => "id" });
    expect(record.redirectUris).toHaveLength(2);
  });

  it("does not decide its own TTL — that's the store's 90-day CLIENT_TTL_MS (Task 14)", async () => {
    const store = makeStore();
    const body = JSON.stringify({ redirect_uris: ["https://app.example.com/cb"] });
    await registerDcrClient(body, { store, generateClientId: () => "id" });
    // putClient is called with exactly (clientId, value) — no third TTL argument for this
    // module to have gotten wrong.
    expect(store.putClient).toHaveBeenCalledWith("id", expect.any(Object));
    expect((store.putClient as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// parseStoredClientRecord — "parse stored data, never cast it"
// ---------------------------------------------------------------------------------------------

describe("parseStoredClientRecord", () => {
  it("round-trips a well-formed record", () => {
    const raw = { clientId: "abc", redirectUris: ["https://app.example.com/cb"], clientName: "Test" };
    expect(parseStoredClientRecord(raw)).toEqual(raw);
  });

  it("throws on a missing clientId", () => {
    expect(() => parseStoredClientRecord({ redirectUris: [] })).toThrow();
  });

  it("throws on a non-array redirectUris", () => {
    expect(() => parseStoredClientRecord({ clientId: "abc", redirectUris: "not-an-array" })).toThrow();
  });

  it("throws on a non-object", () => {
    expect(() => parseStoredClientRecord("nope")).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// resolveClient — routes a URL-shaped client_id to CIMD, anything else to the DCR store.
// ---------------------------------------------------------------------------------------------

describe("resolveClient", () => {
  let fetchImpl: typeof fetch;

  beforeEach(() => {
    fetchImpl = vi.fn(async () => jsonResponse(cimdDoc("https://app.example.com/id"))) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches a CIMD document for an https client_id", async () => {
    const store: ClientStore = { putClient: vi.fn(), getClient: vi.fn(async () => undefined) };
    const record = await resolveClient("https://app.example.com/id", {
      store,
      cimd: { clock: fixedClock, fetchImpl, resolveHost: publicResolveHost },
    });
    expect(record?.clientId).toBe("https://app.example.com/id");
    expect(store.getClient).not.toHaveBeenCalled();
  });

  it("looks up an opaque client_id in the DCR store, never fetching", async () => {
    const stored: ClientRecord = { clientId: "opaque-id", redirectUris: ["https://app.example.com/cb"] };
    const store: ClientStore = { putClient: vi.fn(), getClient: vi.fn(async () => stored) };
    const record = await resolveClient("opaque-id", { store, cimd: { clock: fixedClock, fetchImpl, resolveHost: publicResolveHost } });
    expect(record).toEqual(stored);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
