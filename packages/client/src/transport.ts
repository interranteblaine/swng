import { errorResponseSchema, eventsResponseSchema, parse, recordScoreResponseSchema, wsEnvelopeSchema } from "@swng/contracts";
import type { RecordScoreRequest } from "@swng/contracts";
import type { RoundEvent, RoundId } from "@swng/domain";

export interface PushResult {
  readonly seq?: number;
  readonly duplicate: boolean;
}

export class TransportError extends Error {
  constructor(
    readonly kind: "network" | "server",
    readonly status?: number,
    readonly code?: string,
  ) {
    super(kind === "network" ? "network error" : `server error${status !== undefined ? ` ${status}` : ""}${code ? ` (${code})` : ""}`);
  }
}

export interface RoundTransport {
  push(event: RoundEvent): Promise<PushResult>; // one score-recorded, no seq
  pull(sinceSeq: number): Promise<{ events: readonly RoundEvent[]; nextSeq: number }>;
  // onOpen fires when the underlying socket actually finishes connecting — distinct from
  // "openSocket() was called," since a real WebSocket is CONNECTING (not OPEN) for a while
  // after construction. The caller needs this to close the gap between "requested a
  // connection" and "the connection can actually deliver events": events landing in that
  // gap arrive via neither the connect-time catch-up pull (which already ran) nor the
  // socket (not open yet) unless something re-syncs exactly when it opens.
  openSocket(onEvents: (events: readonly RoundEvent[]) => void, onClose: () => void, onOpen?: () => void): () => void; // returns close()
}

export interface HttpTransportConfig {
  httpUrl: string;
  wsUrl: string;
  roundId: RoundId;
  token: string;
  fetchImpl?: typeof fetch; // injectable for tests and the kill-network toggle
  webSocketCtor?: new (url: string) => WebSocket; // injectable likewise
}

// Every HTTP call shares this: attach the bearer token, turn a rejected fetch into
// TransportError("network"), and turn a non-2xx response into TransportError("server", ...)
// with the server's error code when the body actually parses as one — one place instead of
// push and pull each re-deriving the same mapping.
const requestJson = async (fetchImpl: typeof fetch, url: string, token: string, init?: RequestInit): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, headers: { ...init?.headers, authorization: `Bearer ${token}` } });
  } catch {
    throw new TransportError("network");
  }

  if (!response.ok) {
    // API Gateway itself (not the Lambda behind it) emits a non-JSON body — HTML, plain
    // text — for a Lambda timeout, a throttle, or its own edge 5xx (502/503/429). Parsing
    // `code` off that body is therefore best-effort: a SyntaxError here must not escape as
    // some other error type, or an explicit sync() would REJECT instead of resolving with
    // the queue intact — breaking "offline is not an error" during exactly the outage the
    // queue exists to survive.
    let code: string | undefined;
    try {
      const errorBody = errorResponseSchema.safeParse(await response.json());
      if (errorBody.success) code = errorBody.data.code;
    } catch {
      // non-JSON error body: code stays undefined, status alone still carries the failure.
    }
    throw new TransportError("server", response.status, code);
  }
  return response.json();
};

export const createHttpTransport = (config: HttpTransportConfig): RoundTransport => {
  const { httpUrl, wsUrl, roundId, token } = config;
  const fetchImpl = config.fetchImpl ?? fetch;
  const WebSocketCtor = config.webSocketCtor ?? WebSocket;

  return {
    async push(event: RoundEvent): Promise<PushResult> {
      // v1 clients only ever author score-recorded events (round-created, game-added, etc.
      // go through the session's own command calls, never this generic push) — narrowing
      // here is what lets the wire body below read golferId/hole/result off the union.
      if (event.kind !== "score-recorded") {
        throw new Error(`transport.push only accepts score-recorded events, got "${event.kind}"`);
      }
      // Typed against the wire contract, not just inferred from the domain event, so a
      // future drift between RecordScoreRequest's shape and this literal fails the build
      // here rather than surfacing as a runtime 400 from the server's own schema parse.
      const body: RecordScoreRequest = { golferId: event.golferId, hole: event.hole, result: event.result, opId: event.opId, hlc: event.hlc };

      const json = await requestJson(fetchImpl, `${httpUrl}/rounds/${roundId}/scores`, token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return parse(recordScoreResponseSchema, json);
    },

    async pull(sinceSeq: number): Promise<{ events: readonly RoundEvent[]; nextSeq: number }> {
      const json = await requestJson(fetchImpl, `${httpUrl}/rounds/${roundId}/events?since=${sinceSeq}`, token);
      return parse(eventsResponseSchema, json);
    },

    openSocket(onEvents: (events: readonly RoundEvent[]) => void, onClose: () => void, onOpen?: () => void): () => void {
      const socket = new WebSocketCtor(`${wsUrl}?token=${token}`);
      // The socket can fire both "error" and "close" for the same disconnect; onClose is a
      // lifecycle event for the caller (fire once), not a per-underlying-event echo.
      let closed = false;
      const fireClose = (): void => {
        if (closed) return;
        closed = true;
        onClose();
      };

      socket.onopen = () => onOpen?.();
      socket.onmessage = (event: MessageEvent) => {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(String(event.data));
        } catch {
          return; // malformed message: dropped, never thrown — the socket is delivery sugar
        }
        const envelope = wsEnvelopeSchema.safeParse(parsedJson);
        if (!envelope.success) return;
        if (envelope.data.roundId !== roundId) return;
        onEvents(envelope.data.events);
      };
      socket.onclose = fireClose;
      socket.onerror = fireClose;

      return () => socket.close();
    },
  };
};
