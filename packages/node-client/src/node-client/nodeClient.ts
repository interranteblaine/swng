import { createClient } from "@swng/client";
import type { Client, HttpPort, WebSocketPort, WsHandlers } from "@swng/client";
import { fetch as undiciFetch, WebSocket as UndiciWebSocket } from "undici";

export function createNodeClient(opts: {
  baseUrl: string;
  wsUrl: string;
}): Client {
  const http: HttpPort = {
    async request(req) {
      const res = await undiciFetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
      return {
        ok: res.ok,
        status: res.status,
        bodyText: await res.text(),
      };
    },
  };

  const ws: WebSocketPort = {
    connect(url, protocols, handlers: WsHandlers) {
      const sock = new UndiciWebSocket(url, protocols);

      // open
      try {
        sock.addEventListener?.("open", () => {
          handlers.onOpen?.();
        });
      } catch {
        // ignore
      }

      // message
      sock.addEventListener?.("message", (ev: unknown) => {
        const d = (ev as { data?: unknown })?.data;
        const text =
          typeof d === "string"
            ? d
            : (d as { toString?: () => string })?.toString?.() ?? "";
        if (text) handlers.onMessage(text);
      });

      // error
      try {
        sock.addEventListener?.("error", (ev: unknown) => {
          handlers.onError?.(ev);
        });
      } catch {
        // ignore
      }

      // close
      try {
        sock.addEventListener?.("close", (ev: unknown) => {
          const e = ev as {
            code?: number;
            reason?: string;
            wasClean?: boolean;
          };
          handlers.onClose?.({
            code: e.code ?? 0,
            reason: e.reason ?? "",
            wasClean: Boolean(e.wasClean),
          });
        });
      } catch {
        // ignore
      }

      return {
        close(code?: number, reason?: string) {
          sock.close(code, reason);
        },
      };
    },
  };

  return createClient({
    baseUrl: opts.baseUrl,
    wsUrl: opts.wsUrl,
    http,
    ws,
  });
}
