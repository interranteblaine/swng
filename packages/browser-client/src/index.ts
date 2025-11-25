import { createClient } from "@swng/client";
import type {
  Client,
  HttpPort,
  WebSocketPort,
  WsTextHandler,
} from "@swng/client";

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
    connect(url, protocols, onMessage: WsTextHandler) {
      const sock = new WebSocket(url, protocols);
      sock.onmessage = (ev: MessageEvent) => {
        const d = (ev as MessageEvent & { data: unknown }).data as unknown;
        const text =
          typeof d === "string"
            ? d
            : (d as { toString?: () => string })?.toString?.() ?? "";
        if (text) onMessage(text);
      };
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
