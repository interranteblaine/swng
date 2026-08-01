import { describe, expect, it, vi } from "vitest";
import { deviceId, golferId, opId, roundId } from "@swng/domain";
import type { RoundEvent, RoundId } from "@swng/domain";
import { createHttpTransport, TransportError } from "./transport.js";

const ROUND_ID: RoundId = roundId("round-1");
const HTTP_URL = "https://api.example.test";
const WS_URL = "wss://ws.example.test";
const TOKEN = "tok-abc";

const SCORE_EVENT: RoundEvent = {
  kind: "score-recorded",
  opId: opId("op-1"),
  hlc: { wallMs: 1_000, counter: 0, deviceId: deviceId("phone-a") },
  authorId: golferId("golfer-a"),
  golferId: golferId("golfer-a"),
  hole: 5,
  result: { kind: "strokes", strokes: 4 },
};

// Minimal stand-ins for the two Response fields the transport actually reads.
const fakeResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

// API Gateway itself (not the Lambda behind it) emits these for a Lambda timeout, a
// throttle, or a plain 5xx from the edge — an HTML or plain-text body, never JSON. Models
// that: .json() rejects exactly like the real Response API does on non-JSON bytes.
const fakeNonJsonErrorResponse = (status: number): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON at position 0");
    },
  }) as unknown as Response;

describe("createHttpTransport", () => {
  describe("push", () => {
    it("formats the wire body from the event, sends the bearer token, and parses the response", async () => {
      let seenUrl: string | undefined;
      let seenInit: RequestInit | undefined;
      const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
        seenUrl = String(url);
        seenInit = init;
        return fakeResponse(200, { seq: 42, duplicate: false });
      });
      const transport = createHttpTransport({ httpUrl: HTTP_URL, wsUrl: WS_URL, roundId: ROUND_ID, token: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });

      const result = await transport.push(SCORE_EVENT);

      expect(result).toEqual({ seq: 42, duplicate: false });
      expect(seenUrl).toBe(`${HTTP_URL}/rounds/${ROUND_ID}/scores`);
      expect(seenInit?.method).toBe("POST");
      expect(JSON.parse(String(seenInit?.body))).toEqual({
        golferId: SCORE_EVENT.golferId,
        hole: SCORE_EVENT.hole,
        result: SCORE_EVENT.result,
        opId: SCORE_EVENT.opId,
        hlc: SCORE_EVENT.hlc,
      });
      expect((seenInit?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    });

    it("surfaces a duplicate response as { duplicate: true }", async () => {
      const fetchImpl = (async () => fakeResponse(200, { duplicate: true })) as unknown as typeof fetch;
      const transport = createHttpTransport({ httpUrl: HTTP_URL, wsUrl: WS_URL, roundId: ROUND_ID, token: TOKEN, fetchImpl });

      const result = await transport.push(SCORE_EVENT);

      expect(result).toEqual({ duplicate: true });
    });

    it("surfaces a 409 as TransportError(server, 409, code)", async () => {
      const fetchImpl = (async () => fakeResponse(409, { code: "round-not-live", message: "round is not live" })) as unknown as typeof fetch;
      const transport = createHttpTransport({ httpUrl: HTTP_URL, wsUrl: WS_URL, roundId: ROUND_ID, token: TOKEN, fetchImpl });

      const error = await transport.push(SCORE_EVENT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TransportError);
      expect(error as TransportError).toMatchObject({ kind: "server", status: 409, code: "round-not-live" });
    });

    it("surfaces a fetch rejection as TransportError(network)", async () => {
      const fetchImpl = (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch;
      const transport = createHttpTransport({ httpUrl: HTTP_URL, wsUrl: WS_URL, roundId: ROUND_ID, token: TOKEN, fetchImpl });

      const error = await transport.push(SCORE_EVENT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TransportError);
      expect((error as TransportError).kind).toBe("network");
    });

    // A hung request is the sync loop's worst failure mode: it settles neither arm of doSync, so
    // no retry arms and stalled() never flips. Three properties close it, tested separately
    // because REQUEST_TIMEOUT_MS is a module constant with no injection seam (deliberately —
    // the loop's own cadence is likewise un-injectable), so the timing one has to drive the
    // real 15s on a fake clock.
    //
    // (1) every request carries a timeout signal at all, so none CAN hang forever...
    it("passes an abort signal on every request, so no call can hang forever", async () => {
      const calls: RequestInit[] = [];
      const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        calls.push(init!);
        return String(url).includes("/events") ? fakeResponse(200, { events: [], nextSeq: 0 }) : fakeResponse(200, { seq: 1, duplicate: false });
      }) as unknown as typeof fetch;
      const transport = createHttpTransport({ httpUrl: HTTP_URL, wsUrl: WS_URL, roundId: ROUND_ID, token: TOKEN, fetchImpl });

      await transport.push(SCORE_EVENT);
      await transport.pull(0);

      expect(calls).toHaveLength(2); // push and pull both go through the one requestJson chokepoint
      for (const init of calls) expect(init.signal).toBeInstanceOf(AbortSignal);
      // A FRESH signal per request. Without this, both an inert `new AbortController().signal`
      // and a module-level signal hoisted out of requestJson satisfy the check above — and the
      // hoisted one is worse than no timeout at all, since every request after the app's first
      // 15 seconds would abort instantly.
      expect(calls[0]!.signal).not.toBe(calls[1]!.signal);
    });

    // ...and (2) when that signal fires, the rejection it produces surfaces as the TRANSIENT
    // kind. This is the half that matters for data safety: a timed-out push mapped to a
    // permanent refusal would drop the golfer's score into rejected() instead of requeueing it.
    it("surfaces an abort rejection as the transient TransportError(network), not a permanent refusal", async () => {
      const fetchImpl = (async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }) as unknown as typeof fetch;
      const transport = createHttpTransport({ httpUrl: HTTP_URL, wsUrl: WS_URL, roundId: ROUND_ID, token: TOKEN, fetchImpl });

      const error = await transport.push(SCORE_EVENT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TransportError);
      expect((error as TransportError).kind).toBe("network"); // transient — the event stays queued
    });

    // ...and (3) the timeout actually FIRES, at the bound the module claims. This is only
    // testable at all because the timeout is an AbortController plus a plain setTimeout —
    // AbortSignal.timeout()'s internal timer is not one vitest's fake timers can advance, so
    // this test doubles as the structural guard on that: reverting to the one-liner (which
    // needs Safari 16 / Chrome 103, above this app's own ~Safari 15.4 floor — identity.ts's
    // crypto.randomUUID — and would make every request on an older phone fail permanently)
    // hangs this test rather than passing it.
    it("aborts a request that never settles, at the timeout it claims — a silent hang becomes an ordinary transient", async () => {
      vi.useFakeTimers();
      try {
        // Never resolves on its own: only the abort can end it, exactly like a dead radio or a
        // captive portal holding the socket open.
        const fetchImpl = ((_url: string | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")));
          })) as unknown as typeof fetch;
        const transport = createHttpTransport({ httpUrl: HTTP_URL, wsUrl: WS_URL, roundId: ROUND_ID, token: TOKEN, fetchImpl });

        let settled = false;
        const pushed = transport.push(SCORE_EVENT).catch((error: unknown) => {
          settled = true;
          return error;
        });

        await vi.advanceTimersByTimeAsync(14_999);
        expect(settled).toBe(false); // not a hair-trigger: still waiting at 14.999s

        await vi.advanceTimersByTimeAsync(1);
        const error = await pushed;

        expect(settled).toBe(true);
        expect(error).toBeInstanceOf(TransportError);
        expect((error as TransportError).kind).toBe("network"); // transient — the event stays queued
      } finally {
        vi.useRealTimers();
      }
    });

    // The other half of owning the timer: a response that comes back fast must not leave one
    // armed. Every score entered on a good connection would otherwise hold a 15s timer alive,
    // and close() would have a pending timer behind it for every call it ever made.
    it("clears its timeout once the response lands, so a fast call leaves no timer pending", async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = (async () => fakeResponse(200, { seq: 1, duplicate: false })) as unknown as typeof fetch;
        const transport = createHttpTransport({ httpUrl: HTTP_URL, wsUrl: WS_URL, roundId: ROUND_ID, token: TOKEN, fetchImpl });

        await transport.push(SCORE_EVENT);

        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    // A timeout can land AFTER the headers, while the body is still streaming — the body read
    // then rejects with a DOMException. Left outside the mapping, that escapes as a
    // non-TransportError, so an explicit sync() REJECTS instead of resolving with the queue
    // intact: the same "offline is not an error" breakage the non-JSON error-body case above
    // closes, on the success path.
    it("surfaces a body read that fails after the headers as the transient TransportError(network), not a raw DOMException", async () => {
      const fetchImpl = (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new DOMException("The operation was aborted", "AbortError");
          },
        }) as unknown as Response) as unknown as typeof fetch;
      const transport = createHttpTransport({ httpUrl: HTTP_URL, wsUrl: WS_URL, roundId: ROUND_ID, token: TOKEN, fetchImpl });

      const error = await transport.push(SCORE_EVENT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TransportError);
      expect((error as TransportError).kind).toBe("network"); // transient — the score stays queued
    });

    it("surfaces a non-JSON 502 body (API Gateway's own error page, not the Lambda's) as TransportError(server, 502, undefined), not a raw SyntaxError", async () => {
      const fetchImpl = (async () => fakeNonJsonErrorResponse(502)) as unknown as typeof fetch;
      const transport = createHttpTransport({ httpUrl: HTTP_URL, wsUrl: WS_URL, roundId: ROUND_ID, token: TOKEN, fetchImpl });

      const error = await transport.push(SCORE_EVENT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TransportError);
      expect(error as TransportError).toMatchObject({ kind: "server", status: 502, code: undefined });
    });
  });

  describe("pull", () => {
    it("hits ?since= and parses the response", async () => {
      let seenUrl: string | undefined;
      const fetchImpl = (async (url: string | URL) => {
        seenUrl = String(url);
        return fakeResponse(200, { events: [SCORE_EVENT], nextSeq: 7 });
      }) as unknown as typeof fetch;
      const transport = createHttpTransport({ httpUrl: HTTP_URL, wsUrl: WS_URL, roundId: ROUND_ID, token: TOKEN, fetchImpl });

      const result = await transport.pull(3);

      expect(seenUrl).toBe(`${HTTP_URL}/rounds/${ROUND_ID}/events?since=3`);
      expect(result.nextSeq).toBe(7);
      expect(result.events).toEqual([SCORE_EVENT]);
    });

    it("surfaces a non-JSON 503 body as TransportError(server, 503, undefined), not a raw SyntaxError", async () => {
      const fetchImpl = (async () => fakeNonJsonErrorResponse(503)) as unknown as typeof fetch;
      const transport = createHttpTransport({ httpUrl: HTTP_URL, wsUrl: WS_URL, roundId: ROUND_ID, token: TOKEN, fetchImpl });

      const error = await transport.pull(0).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TransportError);
      expect(error as TransportError).toMatchObject({ kind: "server", status: 503, code: undefined });
    });
  });

  describe("openSocket", () => {
    // A fake WebSocket exposing exactly the surface (onmessage/onclose/onerror + close())
    // that both the real browser WebSocket and Node's `ws` package implement, so the same
    // transport code drives either.
    class FakeSocket {
      static instances: FakeSocket[] = [];
      readonly url: string;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      closeCalls = 0;
      constructor(url: string) {
        this.url = url;
        FakeSocket.instances.push(this);
      }
      close(): void {
        this.closeCalls += 1;
      }
    }

    const openWithFake = (): { transport: ReturnType<typeof createHttpTransport>; socket: FakeSocket; onEvents: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } => {
      FakeSocket.instances = [];
      const transport = createHttpTransport({
        httpUrl: HTTP_URL,
        wsUrl: WS_URL,
        roundId: ROUND_ID,
        token: TOKEN,
        webSocketCtor: FakeSocket as unknown as new (url: string) => WebSocket,
      });
      const onEvents = vi.fn();
      const onClose = vi.fn();
      transport.openSocket(onEvents, onClose);
      const socket = FakeSocket.instances.at(0)!;
      return { transport, socket, onEvents, onClose };
    };

    it("connects with the token as a query param", () => {
      const { socket } = openWithFake();
      expect(socket.url).toBe(`${WS_URL}?token=${TOKEN}`);
    });

    it("parses envelope messages and forwards their events", () => {
      const { socket, onEvents } = openWithFake();

      socket.onmessage?.({ data: JSON.stringify({ type: "events", roundId: ROUND_ID, events: [SCORE_EVENT] }) });

      expect(onEvents).toHaveBeenCalledTimes(1);
      expect(onEvents).toHaveBeenCalledWith([SCORE_EVENT]);
    });

    it("drops envelopes for a different round without forwarding", () => {
      const { socket, onEvents } = openWithFake();

      socket.onmessage?.({ data: JSON.stringify({ type: "events", roundId: "some-other-round", events: [SCORE_EVENT] }) });

      expect(onEvents).not.toHaveBeenCalled();
    });

    it("drops malformed JSON without throwing", () => {
      const { socket, onEvents } = openWithFake();

      expect(() => socket.onmessage?.({ data: "not json" })).not.toThrow();
      expect(onEvents).not.toHaveBeenCalled();
    });

    it("fires onClose exactly once across close and error", () => {
      const { socket, onClose } = openWithFake();

      socket.onclose?.();
      socket.onerror?.();
      socket.onclose?.();

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("the returned close() closes the underlying socket", () => {
      FakeSocket.instances = [];
      const transport = createHttpTransport({
        httpUrl: HTTP_URL,
        wsUrl: WS_URL,
        roundId: ROUND_ID,
        token: TOKEN,
        webSocketCtor: FakeSocket as unknown as new (url: string) => WebSocket,
      });
      const close = transport.openSocket(vi.fn(), vi.fn());
      const socket = FakeSocket.instances.at(0)!;

      close();

      expect(socket.closeCalls).toBe(1);
    });
  });
});
