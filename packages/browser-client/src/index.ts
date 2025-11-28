import { createClient } from "@swng/client";
import type { Client, HttpPort, WebSocketPort, WsHandlers } from "@swng/client";

export function createBrowserClient(opts: {
  baseUrl: string;
  wsUrl: string;
}): Client {
  const http: HttpPort = {
    async request(req) {
      const res = await fetch(req.url, {
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
      const sock = new WebSocket(url, protocols);

      try {
        sock.onopen = () => {
          handlers.onOpen?.();
        };
      } catch {
        // ignore
      }

      sock.onmessage = (ev: MessageEvent) => {
        const d = (ev as MessageEvent & { data: unknown }).data as unknown;
        const text =
          typeof d === "string"
            ? d
            : (d as { toString?: () => string })?.toString?.() ?? "";
        if (text) handlers.onMessage(text);
      };

      try {
        sock.onerror = (ev: Event) => {
          handlers.onError?.(ev);
        };
      } catch {
        // ignore
      }

      try {
        sock.onclose = (ev: CloseEvent) => {
          handlers.onClose?.({
            code: ev.code,
            reason: ev.reason,
            wasClean: ev.wasClean,
          });
        };
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
