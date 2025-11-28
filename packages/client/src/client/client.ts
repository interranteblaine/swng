import { createHttpClient } from "./http";
import { Client, CreateClientOptions } from "./types";
import { connectEvents } from "./wsReliable";

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
    connectEvents: (sessionId, onEvent, opts) =>
      connectEvents(ws, wsUrl, sessionId, onEvent, opts),
  };
}
