import { DomainEvent } from "@swng/domain";
import { createNodeClient } from "./nodeClient";

export async function verifyStaging(
  apiUrl: string,
  wsUrl: string
): Promise<void> {
  const client = createNodeClient({ baseUrl: apiUrl, wsUrl });

  // 1) Create round
  const created = await client.createRound({
    courseName: "Smoke",
    par: [3, 3, 3],
  });
  if (!created?.config?.roundId)
    throw new Error("createRound: missing roundId");
  if (!created?.config?.accessCode)
    throw new Error("createRound: missing accessCode");

  // 2) Join round as A and open WS
  const joinA = await client.joinRound({
    accessCode: created.config.accessCode,
    playerName: `A-${Date.now()}`,
  });
  const roundId = joinA.roundId;
  const sessionA = joinA.sessionId;
  if (!roundId) throw new Error("joinRound(A): missing roundId");
  if (!sessionA) throw new Error("joinRound(A): missing sessionId");

  const events: DomainEvent[] = [];
  const connA = client.connectWs(sessionA, (evt) => {
    events.push(evt);
  });

  let closed = false;
  try {
    // 3) Join round as B -> expect PlayerJoined
    clear(events);
    const joinB = await client.joinRound({
      accessCode: created.config.accessCode,
      playerName: `B-${Date.now()}`,
    });
    if (!joinB?.player?.playerId)
      throw new Error("joinRound(B): missing playerId");
    const playerB = joinB.player;
    const sessionB = joinB.sessionId;
    if (!sessionB) throw new Error("joinRound(B): missing sessionId");

    await waitForNext(
      events,
      (e) =>
        e?.type === "PlayerJoined" && e?.player?.playerId === playerB.playerId
    );

    // 4) Update player (B) -> expect PlayerUpdated
    clear(events);
    const newName = "B2";
    await client.updatePlayer({
      roundId,
      sessionId: sessionB,
      playerId: playerB.playerId,
      name: newName,
    });
    await waitForNext(
      events,
      (e) =>
        e?.type === "PlayerUpdated" &&
        e?.player?.playerId === playerB.playerId &&
        e?.player?.name === newName
    );

    // 5) Update score (B) -> expect ScoreChanged
    clear(events);
    await client.updateScore({
      roundId,
      sessionId: sessionB,
      playerId: playerB.playerId,
      holeNumber: 1,
      strokes: 3,
    });
    await waitForNext(
      events,
      (e) =>
        e?.type === "ScoreChanged" &&
        e?.score?.playerId === playerB.playerId &&
        e?.score?.holeNumber === 1 &&
        e?.score?.strokes === 3
    );

    // 6) Patch round state (A) -> expect RoundStateChanged
    clear(events);
    const before = await client.getRound({ roundId, sessionId: sessionA });
    const nextHole = (before?.snapshot?.state?.currentHole ?? 1) + 1;
    await client.patchRoundState({
      roundId,
      sessionId: sessionA,
      currentHole: nextHole,
    });
    await waitForNext(
      events,
      (e) =>
        e?.type === "RoundStateChanged" && e?.state?.currentHole === nextHole
    );

    connA.close();
    closed = true;
  } finally {
    if (!closed) {
      try {
        connA.close();
      } catch {
        // ignore
      }
    }
  }
}

function clear(arr: DomainEvent[]) {
  arr.length = 0;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForNext(
  events: DomainEvent[],
  match: (e: DomainEvent) => boolean,
  timeoutMs = 3000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const e of events) {
      if (match(e)) return;
    }
    await sleep(150);
  }
  throw new Error("Timed out waiting for expected event");
}
