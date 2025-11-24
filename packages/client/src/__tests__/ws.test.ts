import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DomainEvent } from "@swng/domain";
import { connectWs } from "../index";

class FakeWebSocket {
  static last: FakeWebSocket | undefined;

  public readonly url: string;
  public readonly protocols?: string[];
  private listeners: Record<string, ((ev: { data: unknown }) => void)[]> = {};
  private closed = false;

  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.last = this;
  }

  addEventListener(type: string, listener: (ev: { data: unknown }) => void) {
    (this.listeners[type] ||= []).push(listener);
  }

  close(): void {
    this.closed = true;
  }

  emitMessage(payload: unknown): void {
    if (this.closed) return;
    const ev = {
      data: typeof payload === "string" ? payload : JSON.stringify(payload),
    };
    for (const fn of this.listeners["message"] ?? []) fn(ev);
  }
}

describe("connectWs (behavior)", () => {
  const original = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;

  beforeEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket =
      FakeWebSocket as unknown;
    FakeWebSocket.last = undefined;
  });

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
    } else {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = original;
    }
    FakeWebSocket.last = undefined;
  });

  it("uses subprotocol 'Session <id>' and returns a socket", () => {
    const ws = connectWs("wss://example/ws", "s1", () => {});
    expect(FakeWebSocket.last?.protocols?.[0]).toBe("Session s1");
    expect(typeof ws.close).toBe("function");
    ws.close();
  });

  it("forwards a valid DomainEvent to the callback", () => {
    let received: DomainEvent | undefined;
    const ws = connectWs("wss://example/ws", "s1", (evt) => {
      received = evt;
    });

    FakeWebSocket.last?.emitMessage({
      type: "ScoreChanged",
      roundId: "r1",
      occurredAt: "2020-01-01T00:00:00Z",
      score: {
        roundId: "r1",
        playerId: "p1",
        holeNumber: 1,
        strokes: 3,
        updatedBy: "p1",
        updatedAt: "2020-01-01T00:00:00Z",
      },
    });

    expect(received?.type).toBe("ScoreChanged");
    ws.close();
  });
});
