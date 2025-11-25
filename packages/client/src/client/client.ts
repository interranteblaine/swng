import { createHttpClient } from "./http";
import { Client, CreateClientOptions } from "./types";
import { connectWs } from "./ws";

export function createClient(opts: CreateClientOptions): Client {
  const { http, ws, baseUrl, wsUrl } = opts;
  const httpClient = createHttpClient(http, baseUrl);

  return {
    createRound: httpClient.createRound,
    joinRound: httpClient.joinRound,
    getRound: httpClient.getRound,
    updateScore: httpClient.updateScore,
    patchRoundState: httpClient.patchRoundState,
    updatePlayer: httpClient.updatePlayer,
    connectWs: (sessionId, onEvent) => connectWs(ws, wsUrl, sessionId, onEvent),
  };
}
