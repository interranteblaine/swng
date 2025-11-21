import { describe, it, expect, beforeEach } from "vitest";
import { createDynamoSessionRepository } from "../adapters-dynamodb/sessionRepository";
import {
  createDocClientFake,
  newTestConfig,
  sampleSession,
} from "./dynamoTestUtils";

describe("createDynamoSessionRepository behavior", () => {
  let repo: ReturnType<typeof createDynamoSessionRepository>;

  beforeEach(() => {
    const docClient = createDocClientFake();
    const cfg = newTestConfig(docClient);
    repo = createDynamoSessionRepository(cfg);
  });

  it("getSession returns null when missing", async () => {
    const out = await repo.getSession("sid-missing");
    expect(out).toBeNull();
  });

  it("createSession persists and getSession returns it", async () => {
    const s = sampleSession({
      sessionId: "sid-1",
      roundId: "rid-1",
      playerId: "pid-1",
    });
    await repo.createSession(s);

    const found = await repo.getSession("sid-1");
    expect(found).not.toBeNull();
    expect(found).toMatchObject({
      sessionId: "sid-1",
      roundId: "rid-1",
      playerId: "pid-1",
      expiresAt: s.expiresAt,
    });
  });

  it("creates multiple sessions and retrieves the correct one by id", async () => {
    const s1 = sampleSession({
      sessionId: "sid-1",
      roundId: "rid-1",
      playerId: "pid-1",
    });
    const s2 = sampleSession({
      sessionId: "sid-2",
      roundId: "rid-2",
      playerId: "pid-9",
    });
    await repo.createSession(s1);
    await repo.createSession(s2);

    const found1 = await repo.getSession("sid-1");
    const found2 = await repo.getSession("sid-2");

    expect(found1).toMatchObject({
      sessionId: "sid-1",
      roundId: "rid-1",
      playerId: "pid-1",
    });
    expect(found2).toMatchObject({
      sessionId: "sid-2",
      roundId: "rid-2",
      playerId: "pid-9",
    });
  });
});
