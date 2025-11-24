import type { DomainEvent } from "@swng/domain";

/**
 * Open a browser WebSocket authenticated via subprotocol "Session <sessionId>".
 * Returns the WebSocket instance so callers can close() explicitly.
 */
export function connectWs(
  wsUrl: string,
  sessionId: string,
  onEvent: (evt: DomainEvent) => void
): WebSocket {
  if (typeof WebSocket !== "function") {
    throw new Error("global WebSocket not available (browser-only client)");
  }
  if (!sessionId) {
    throw new Error("sessionId is required to connect WebSocket");
  }

  const ws = new WebSocket(wsUrl, [`Session ${sessionId}`]);

  ws.addEventListener("message", (ev) => {
    try {
      const text =
        typeof ev.data === "string" ? ev.data : ev.data?.toString?.();
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
