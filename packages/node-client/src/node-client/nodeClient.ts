import { createClient } from "@swng/client";
import type {
  Client,
  HttpPort,
  WebSocketPort,
  WsTextHandler,
} from "@swng/client";
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
    connect(url, protocols, onMessage: WsTextHandler) {
      const sock = new UndiciWebSocket(url, protocols);
      sock.addEventListener?.("message", (ev: unknown) => {
        const d = (ev as { data?: unknown })?.data;
        const text =
          typeof d === "string"
            ? d
            : (d as { toString?: () => string })?.toString?.() ?? "";
        if (text) onMessage(text);
      });
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
