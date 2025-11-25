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

export type WsTextHandler = (data: string) => void;

export interface WsConnection {
  close(code?: number, reason?: string): void;
}

export interface WebSocketPort {
  connect(
    url: string,
    protocols: string[],
    onMessage: WsTextHandler
  ): WsConnection;
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
  connectWs(
    sessionId: string,
    onEvent: (evt: DomainEvent) => void
  ): WsConnection;
}

export interface CreateClientOptions {
  http: HttpPort;
  ws: WebSocketPort;
  baseUrl: string;
  wsUrl: string;
}
