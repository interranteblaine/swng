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
    deleteScore: httpClient.deleteScore,
    patchRoundState: httpClient.patchRoundState,
    updatePlayer: httpClient.updatePlayer,
    removePlayer: httpClient.removePlayer,
    listCourses: httpClient.listCourses,
    getCourse: httpClient.getCourse,
    connectEvents: (sessionId, onEvent, opts) =>
      connectEvents(ws, wsUrl, sessionId, onEvent, opts),
  };
}
