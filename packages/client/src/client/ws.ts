import type { DomainEvent } from "@swng/domain";
import type {
  WebSocketCtorLike,
  WebSocketLike,
  MessageEventLike,
} from "./types";

/**
 * Create a WebSocket connection using an injected constructor.
 * Auth is provided via subprotocol "Session <sessionId>".
 */
export function connectWsWithCtor(
  wsCtor: WebSocketCtorLike,
  wsUrl: string,
  sessionId: string,
  onEvent: (evt: DomainEvent) => void
): WebSocketLike {
  if (!sessionId) {
    throw new Error("sessionId is required to connect WebSocket");
  }

  const ws = new wsCtor(wsUrl, [`Session ${sessionId}`]);

  ws.addEventListener("message", (ev: MessageEventLike) => {
    try {
      const text =
        typeof ev.data === "string"
          ? ev.data
          : (
              ev as unknown as { data?: { toString?: () => string } }
            ).data?.toString?.();
      if (!text || typeof text !== "string") return;
      const msg = JSON.parse(text);
      if (msg && typeof msg === "object" && "type" in msg) {
        onEvent(msg as DomainEvent);
      }
    } catch {
      // ignore malformed payloads
    }
  });

  return ws;
}
