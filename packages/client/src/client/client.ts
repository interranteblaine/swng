import { DomainEvent } from "@swng/domain";
import { createHttpClient } from "./http";
import { Client, CreateClientOptions, WebSocketLike } from "./types";
import { connectWsWithCtor } from "./ws";

export function createClient(opts: CreateClientOptions): Client {
  const { fetch: fetchImpl, wsCtor, baseUrl, wsUrl } = opts;
  const http = createHttpClient(fetchImpl, baseUrl);

  return {
    createRound: http.createRound,
    joinRound: http.joinRound,
    getRound: http.getRound,
    updateScore: http.updateScore,
    patchRoundState: http.patchRoundState,
    updatePlayer: http.updatePlayer,
    connectWs: (
      sessionId: string,
      onEvent: (evt: DomainEvent) => void
    ): WebSocketLike => connectWsWithCtor(wsCtor, wsUrl, sessionId, onEvent),
  };
}
