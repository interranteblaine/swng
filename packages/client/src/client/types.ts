import type {
  CreateRoundOutput,
  JoinRoundOutput,
  GetRoundOutput,
  UpdateScoreOutput,
  PatchRoundStateOutput,
  UpdatePlayerOutput,
} from "@swng/application";
import type {
  CreateRoundRequest,
  JoinRoundRequest,
  UpdateScoreRequest,
  PatchRoundStateRequest,
  UpdatePlayerRequest,
} from "@swng/contracts";
import type { RoundId } from "@swng/domain";
import type { DomainEvent } from "@swng/domain";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH";

export interface HttpRequest {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: string; // JSON string when present
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  bodyText: string;
}

export interface HttpPort {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export type WsStatus = "connecting" | "open" | "error" | "closed";

export interface WsHandlers {
  onOpen?: () => void;
  onMessage: (data: string) => void;
  onClose?: (e: { code: number; reason: string; wasClean: boolean }) => void;
  onError?: (err: unknown) => void;
}

export interface WsConnection {
  close(code?: number, reason?: string): void;
}

export interface WebSocketPort {
  connect(url: string, protocols: string[], handlers: WsHandlers): WsConnection;
}

export interface WsSession {
  close(): void;
  getStatus(): WsStatus;
  onStatus(cb: (s: WsStatus) => void): () => void;
}

export interface Client {
  createRound(input: CreateRoundRequest): Promise<CreateRoundOutput>;
  joinRound(input: JoinRoundRequest): Promise<JoinRoundOutput>;
  getRound(args: {
    roundId: RoundId;
    sessionId: string;
  }): Promise<GetRoundOutput>;
  updateScore(
    args: { roundId: RoundId; sessionId: string } & UpdateScoreRequest
  ): Promise<UpdateScoreOutput>;
  patchRoundState(
    args: { roundId: RoundId; sessionId: string } & PatchRoundStateRequest
  ): Promise<PatchRoundStateOutput>;
  updatePlayer(
    args: {
      roundId: RoundId;
      sessionId: string;
      playerId: string;
    } & UpdatePlayerRequest
  ): Promise<UpdatePlayerOutput>;
  connectEvents(
    sessionId: string,
    onEvent: (evt: DomainEvent) => void,
    opts?: {
      backoffMs?: (attempt: number) => number;
      classifyClose?: (code: number) => "retry" | "fatal";
    }
  ): WsSession;
}

export interface CreateClientOptions {
  http: HttpPort;
  ws: WebSocketPort;
  baseUrl: string;
  wsUrl: string;
}
