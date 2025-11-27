import { describe, it, expect } from "vitest";
import type { DomainEvent } from "@swng/domain";
import { connectWs } from "../index";
import type { WebSocketPort } from "../client/types";

describe("connectWs (WebSocketPort)", () => {
  // Minimal fake WebSocketPort that records the last connection
  let last:
    | {
        url: string;
        protocols: string[];
        onMessage?: (data: string) => void;
        closed: boolean;
      }
    | undefined;

  const port: WebSocketPort = {
    connect(url, protocols, onMessage) {
      last = { url, protocols, onMessage, closed: false };
      return {
        close(code?: number, reason?: string) {
          // simulate close semantics
          if (last) last.closed = true;
          void code;
          void reason;
        },
      };
    },
  };

  function emit(payload: unknown) {
    const text =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    last?.onMessage?.(text);
  }

  it("appends ?session=<id>", () => {
    const ws = connectWs(port, "wss://example/ws", "s1", () => {});
    expect(last?.url).toBe("wss://example/ws?session=s1");
    expect(last?.protocols?.length).toBe(0);
    expect(typeof ws.close).toBe("function");
    ws.close();
  });

  it("forwards a valid DomainEvent to the callback", () => {
    let received: DomainEvent | undefined;
    const ws = connectWs(port, "wss://example/ws", "s1", (evt) => {
      received = evt;
    });

    emit({
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
