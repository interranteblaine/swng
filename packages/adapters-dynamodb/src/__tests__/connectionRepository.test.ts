import { describe, it, expect, beforeEach } from "vitest";
import { createDynamoConnectionRepository } from "../adapters-dynamodb/connectionRepository";
import {
  createDocClientFake,
  newTestConfig,
  sampleConnection,
} from "./dynamoTestUtils";

describe("createDynamoConnectionRepository behavior", () => {
  let repo: ReturnType<typeof createDynamoConnectionRepository>;

  beforeEach(() => {
    const docClient = createDocClientFake();
    const cfg = newTestConfig(docClient);
    repo = createDynamoConnectionRepository(cfg);
  });

  it("listConnections returns empty when none exist", async () => {
    const list = await repo.listConnections("rid-1");
    expect(list).toEqual([]);
  });

  it("addConnection persists and listConnections returns it", async () => {
    await repo.addConnection(sampleConnection());
    const list = await repo.listConnections("rid-1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      roundId: "rid-1",
      connectionId: "cid-1",
      playerId: "pid-1",
    });
  });

  it("removeConnection deletes the connection", async () => {
    await repo.addConnection(sampleConnection());
    await repo.removeConnection("rid-1", "cid-1");

    const list = await repo.listConnections("rid-1");
    expect(list).toEqual([]);
  });

  it("does not mix connections across rounds", async () => {
    await repo.addConnection(
      sampleConnection({ roundId: "rid-1", connectionId: "c1" })
    );
    await repo.addConnection(
      sampleConnection({ roundId: "rid-2", connectionId: "c2" })
    );

    const list1 = await repo.listConnections("rid-1");
    const list2 = await repo.listConnections("rid-2");

    expect(list1).toHaveLength(1);
    expect(list1[0]).toMatchObject({ roundId: "rid-1", connectionId: "c1" });

    expect(list2).toHaveLength(1);
    expect(list2[0]).toMatchObject({ roundId: "rid-2", connectionId: "c2" });
  });

  it("addConnection with ttlSeconds still returns same visible fields", async () => {
    await repo.addConnection(sampleConnection({ connectionId: "c3" }), 60);
    const list = await repo.listConnections("rid-1");
    expect(list).toEqual([
      expect.objectContaining({ connectionId: "c3", playerId: "pid-1" }),
    ]);
  });
});
