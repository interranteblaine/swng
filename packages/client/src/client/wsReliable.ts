import type { DomainEvent } from "@swng/domain";
import type {
  WebSocketPort,
  WsHandlers,
  WsSession,
  WsStatus,
  WsConnection,
} from "./types";

function defaultBackoff(attempt: number): number {
  // 250ms, 500ms, 1000ms, ..., capped at 10s, plus small jitter 0..250
  const base = 250 * Math.pow(2, Math.max(0, attempt - 1));
  const cap = 10_000;
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(cap, base) + jitter;
}

function defaultClassifyClose(code: number): "retry" | "fatal" {
  // Fatal: policy/protocol/unsupported/bad data
  if (code === 1008 || code === 1002 || code === 1003 || code === 1007) {
    return "fatal";
  }
  return "retry";
}

function buildUrl(wsUrl: string, sessionId: string): string {
  return wsUrl.includes("?")
    ? `${wsUrl}&session=${encodeURIComponent(sessionId)}`
    : `${wsUrl}?session=${encodeURIComponent(sessionId)}`;
}

function toOnMessage(
  onEvent: (evt: DomainEvent) => void
): (text: string) => void {
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

export function connectEvents(
  ws: WebSocketPort,
  wsUrl: string,
  sessionId: string,
  onEvent: (evt: DomainEvent) => void,
  opts?: {
    backoffMs?: (attempt: number) => number;
    classifyClose?: (code: number) => "retry" | "fatal";
  }
): WsSession {
  if (!sessionId) throw new Error("sessionId is required to connect WebSocket");

  const backoff = opts?.backoffMs ?? defaultBackoff;
  const classify = opts?.classifyClose ?? defaultClassifyClose;

  const url = buildUrl(wsUrl, sessionId);
  let status: WsStatus = "connecting";
  const listeners = new Set<(s: WsStatus) => void>();
  let stopped = false;
  let attempt = 1;
  let reconnectT: ReturnType<typeof setTimeout> | null = null;
  let conn: WsConnection | null = null;

  function setStatus(s: WsStatus) {
    status = s;
    for (const cb of listeners) {
      try {
        cb(s);
      } catch {
        // ignore listener errors
      }
    }
  }

  function clearReconnectTimer() {
    if (reconnectT) {
      clearTimeout(reconnectT);
      reconnectT = null;
    }
  }

  function scheduleReconnect() {
    if (stopped) return;

    // Optional offline/online browser handling:
    if (
      typeof window !== "undefined" &&
      typeof navigator !== "undefined" &&
      (navigator as { onLine?: boolean })?.onLine === false
    ) {
      // Wait for 'online' then reconnect immediately once
      const onOnline = () => {
        try {
          window.removeEventListener("online", onOnline as EventListener);
        } catch {
          // ignore
        }
        if (stopped) return;
        setStatus("connecting");
        connectOnce();
      };
      try {
        window.addEventListener("online", onOnline as EventListener, {
          once: true,
        });
      } catch {
        // ignore
      }
      setStatus("error");
      return;
    }

    const delay = backoff(attempt++);
    setStatus("error");
    reconnectT = setTimeout(() => {
      if (stopped) return;
      setStatus("connecting");
      connectOnce();
    }, delay);
  }

  function handleFailure(code: number) {
    if (stopped) {
      setStatus("closed");
      return;
    }
    const verdict = classify(code);
    if (verdict === "fatal") {
      setStatus("closed");
      return;
    }
    scheduleReconnect();
  }

  function connectOnce() {
    const handlers: WsHandlers = {
      onOpen: () => {
        attempt = 1;
        setStatus("open");
      },
      onMessage: toOnMessage(onEvent),
      onClose: (e) => {
        // Normalize missing code
        handleFailure(typeof e?.code === "number" ? e.code : 0);
      },
      onError: () => {
        handleFailure(0);
      },
    };

    try {
      conn = ws.connect(url, [], handlers);
    } catch {
      handleFailure(0);
    }
  }

  // initial connect
  connectOnce();

  return {
    close() {
      stopped = true;
      clearReconnectTimer();
      try {
        conn?.close(1000, "client_close");
      } catch {
        // ignore
      }
      setStatus("closed");
    },
    getStatus() {
      return status;
    },
    onStatus(cb: (s: WsStatus) => void) {
      listeners.add(cb);
      try {
        cb(status);
      } catch {
        // ignore
      }
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
