import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "@swng/application";
import {
  CIMD_MAX_BYTES,
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
  it("allows an exact non-loopback match", () => {
    expect(redirectUriAllowed(["https://app.example.com/cb"], "https://app.example.com/cb")).toBe(true);
  });

  it("refuses a non-loopback host with a different port", () => {
    expect(redirectUriAllowed(["https://app.example.com:443/cb"], "https://app.example.com:8443/cb")).toBe(false);
  });

  it("refuses a non-loopback host with a different path", () => {
    expect(redirectUriAllowed(["https://app.example.com/cb"], "https://app.example.com/other")).toBe(false);
  });

  it("refuses a non-loopback host that merely shares a hostname suffix", () => {
    expect(redirectUriAllowed(["https://app.example.com/cb"], "https://evil-app.example.com/cb")).toBe(false);
  });

  it("matches localhost loopback across different ephemeral ports", () => {
    expect(redirectUriAllowed(["http://localhost:51000/cb"], "http://localhost:61999/cb")).toBe(true);
  });

  it("matches 127.0.0.1 loopback across different ephemeral ports", () => {
    expect(redirectUriAllowed(["http://127.0.0.1:51000/cb"], "http://127.0.0.1:61999/cb")).toBe(true);
  });

  it("still refuses a loopback redirect whose PATH differs — port-agnostic never means path-agnostic", () => {
    expect(redirectUriAllowed(["http://127.0.0.1:51000/cb"], "http://127.0.0.1:61999/steal")).toBe(false);
  });

  it("still refuses a loopback-looking HOST that is not the registered loopback host", () => {
    // 127.0.0.2 is not in the registered set and is not string-equal to 127.0.0.1 — host is
    // never relaxed, so this must NOT be treated as "the same loopback host, different port."
    expect(redirectUriAllowed(["http://127.0.0.1:51000/cb"], "http://127.0.0.2:51000/cb")).toBe(false);
  });

  it("refuses an attacker-controlled redirect_uri entirely absent from the registered set", () => {
    expect(redirectUriAllowed(["https://app.example.com/cb"], "https://attacker.example/cb")).toBe(false);
  });

  it("refuses a malformed requested URI rather than throwing", () => {
    expect(redirectUriAllowed(["https://app.example.com/cb"], "not-a-url")).toBe(false);
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

  it("enforces the 64 KB response cap", async () => {
    const oversized = "x".repeat(CIMD_MAX_BYTES + 1);
    const fetchImpl = vi.fn(async () => jsonResponse(oversized));
    await expect(fetchCimdClient("https://app.example.com/id", { clock: fixedClock, fetchImpl, resolveHost: publicResolveHost })).rejects.toThrow(
      ClientRegistrationError,
    );
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
});

describe("registerDcrClient", () => {
  const makeStore = (): ClientStore & { putClient: ReturnType<typeof vi.fn>; getClient: ReturnType<typeof vi.fn> } => ({
    putClient: vi.fn(async () => undefined),
    getClient: vi.fn(async () => undefined),
  });

  it("stores the registered client and returns it", async () => {
    const store = makeStore();
    const body = JSON.stringify({ redirect_uris: ["https://app.example.com/cb"] });
    const record = await registerDcrClient(body, { store, generateClientId: () => "fixed-client-id" });
    expect(record).toEqual({ clientId: "fixed-client-id", redirectUris: ["https://app.example.com/cb"], clientName: undefined });
    expect(store.putClient).toHaveBeenCalledWith("fixed-client-id", record);
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
