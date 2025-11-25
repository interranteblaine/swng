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

export type HeadersInitLike = Record<string, string> | Array<[string, string]>;

export interface RequestInitLike {
  method?: string;
  headers?: HeadersInitLike;
  body?: string | Uint8Array | null;
}

export interface ResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: RequestInitLike
) => Promise<ResponseLike>;

export interface MessageEventLike {
  data: unknown;
}

export type WsEventHandler = (ev?: unknown) => void;
export type WsMessageHandler = (ev: MessageEventLike) => void;

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;

  onopen?: WsEventHandler | null;
  onmessage?: WsMessageHandler | null;
  onclose?: WsEventHandler | null;
  onerror?: WsEventHandler | null;

  addEventListener(type: "open", listener: WsEventHandler): void;
  addEventListener(type: "close", listener: WsEventHandler): void;
  addEventListener(type: "error", listener: WsEventHandler): void;
  addEventListener(type: "message", listener: WsMessageHandler): void;

  removeEventListener(type: "open", listener: WsEventHandler): void;
  removeEventListener(type: "close", listener: WsEventHandler): void;
  removeEventListener(type: "error", listener: WsEventHandler): void;
  removeEventListener(type: "message", listener: WsMessageHandler): void;
}

export type WebSocketCtorLike = new (
  url: string,
  protocols?: string | string[]
) => WebSocketLike;

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
  ): WebSocketLike;
}

export interface CreateClientOptions {
  fetch: FetchLike;
  wsCtor: WebSocketCtorLike;
  baseUrl: string;
  wsUrl: string;
}
