import { DomainEvent } from "@swng/domain";
import { createNodeClient } from "./nodeClient";

function summarizeEvents(events: DomainEvent[]): string {
  return events.map((e) => e?.type ?? "unknown").join(", ") || "(none)";
}

async function waitForNextLogged(
  events: DomainEvent[],
  match: (e: DomainEvent) => boolean,
  label: string,
  timeoutMs = 3000
): Promise<void> {
  console.log(`[WAIT] ${label} (timeout ${timeoutMs}ms)`);
  try {
    await waitForNext(events, match, timeoutMs);
    console.log(`[OK] ${label}`);
  } catch (err) {
    console.error(
      `[TIMEOUT] ${label}; seen events so far: ${summarizeEvents(events)}`
    );
    throw err;
  }
}

export async function verifyStaging(
  apiUrl: string,
  wsUrl: string
): Promise<void> {
  console.log(`[START] verifyStaging`);
  console.log(`[CFG] apiUrl=${apiUrl}`);
  console.log(`[CFG] wsUrl=${wsUrl}`);

  const client = createNodeClient({ baseUrl: apiUrl, wsUrl });

  // 1) Create round
  console.log(`[STEP] createRound`);
  const created = await client.createRound({
    courseName: "Smoke",
    par: [3, 3, 3],
  });
  if (!created?.config?.roundId)
    throw new Error("createRound: missing roundId");
  if (!created?.config?.accessCode)
    throw new Error("createRound: missing accessCode");
  console.log(
    `[OK] createRound roundId=${created.config.roundId} accessCode=${created.config.accessCode}`
  );

  // 2) Join round as A and open WS
  console.log(`[STEP] joinRound as A and open WS`);
  const joinA = await client.joinRound({
    accessCode: created.config.accessCode,
    playerName: `A-${Date.now()}`,
  });
  const roundId = joinA.roundId;
  const sessionA = joinA.sessionId;
  if (!roundId) throw new Error("joinRound(A): missing roundId");
  if (!sessionA) throw new Error("joinRound(A): missing sessionId");
  console.log(
    `[OK] joinRound(A) roundId=${roundId} sessionA=${sessionA} playerId=${
      joinA.player?.playerId ?? "n/a"
    }`
  );

  const events: DomainEvent[] = [];
  console.log(`[WS] connecting for sessionA... (events will be logged)`);
  const connA = client.connectWs(sessionA, (evt) => {
    events.push(evt);
    try {
      console.log(`[EVENT] ${evt.type}`);
    } catch {
      // ignore logging failures
    }
  });

  let closed = false;
  try {
    // 3) Join round as B -> expect PlayerJoined
    console.log(`[STEP] joinRound as B -> expect PlayerJoined`);
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
    console.log(
      `[OK] joinRound(B) playerB=${playerB.playerId} sessionB=${sessionB}`
    );

    await waitForNextLogged(
      events,
      (e) =>
        e?.type === "PlayerJoined" && e?.player?.playerId === playerB.playerId,
      `PlayerJoined for playerB=${playerB.playerId}`
    );

    // 4) Update player (B) -> expect PlayerUpdated
    console.log(`[STEP] updatePlayer(B) -> expect PlayerUpdated`);
    clear(events);
    const newName = "B2";
    await client.updatePlayer({
      roundId,
      sessionId: sessionB,
      playerId: playerB.playerId,
      name: newName,
    });
    await waitForNextLogged(
      events,
      (e) =>
        e?.type === "PlayerUpdated" &&
        e?.player?.playerId === playerB.playerId &&
        e?.player?.name === newName,
      `PlayerUpdated name=${newName} for playerB=${playerB.playerId}`
    );

    // 5) Update score (B) -> expect ScoreChanged
    console.log(`[STEP] updateScore(B) -> expect ScoreChanged`);
    clear(events);
    await client.updateScore({
      roundId,
      sessionId: sessionB,
      playerId: playerB.playerId,
      holeNumber: 1,
      strokes: 3,
    });
    await waitForNextLogged(
      events,
      (e) =>
        e?.type === "ScoreChanged" &&
        e?.score?.playerId === playerB.playerId &&
        e?.score?.holeNumber === 1 &&
        e?.score?.strokes === 3,
      `ScoreChanged playerB=${playerB.playerId} hole=1 strokes=3`
    );

    // 6) Patch round state (A) -> expect RoundStateChanged
    console.log(`[STEP] patchRoundState(A) -> expect RoundStateChanged`);
    clear(events);
    const before = await client.getRound({ roundId, sessionId: sessionA });
    const nextHole = (before?.snapshot?.state?.currentHole ?? 1) + 1;
    console.log(
      `[INFO] currentHole(before)=${
        before?.snapshot?.state?.currentHole ?? "n/a"
      } nextHole=${nextHole}`
    );
    await client.patchRoundState({
      roundId,
      sessionId: sessionA,
      currentHole: nextHole,
    });
    await waitForNextLogged(
      events,
      (e) =>
        e?.type === "RoundStateChanged" && e?.state?.currentHole === nextHole,
      `RoundStateChanged nextHole=${nextHole}`
    );

    console.log(`[WS] closing for sessionA`);
    connA.close();
    closed = true;
    console.log(`[DONE] verifyStaging successful`);
  } catch (err) {
    console.error(`[ERROR] verifyStaging failed:`, err);
    throw err;
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
