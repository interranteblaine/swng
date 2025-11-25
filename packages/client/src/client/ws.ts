import type { DomainEvent } from "@swng/domain";
import type { WebSocketPort, WsTextHandler, WsConnection } from "./types";

function toDomainEventHandler(
  onEvent: (evt: DomainEvent) => void
): WsTextHandler {
  return (text: string) => {
    try {
      const msg = JSON.parse(text);
      if (msg && typeof msg === "object" && "type" in msg) {
        onEvent(msg as DomainEvent);
      }
    } catch {
      // ignore malformed payloads
    }
  };
}

/**
 * Create a WebSocket connection using the WebSocketPort.
 * Auth is provided via subprotocol "Session <sessionId>".
 */
export function connectWs(
  ws: WebSocketPort,
  wsUrl: string,
  sessionId: string,
  onEvent: (evt: DomainEvent) => void
): WsConnection {
  if (!sessionId) {
    throw new Error("sessionId is required to connect WebSocket");
  }
  const handler = toDomainEventHandler(onEvent);
  return ws.connect(wsUrl, [`Session ${sessionId}`], handler);
}
