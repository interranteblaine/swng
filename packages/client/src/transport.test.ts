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
