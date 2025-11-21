import { describe, it, expect, beforeEach } from "vitest";
import { createDynamoPlayerRepository } from "../adapters-dynamodb/playerRepository";
import {
  createDocClientFake,
  newTestConfig,
  samplePlayer,
} from "./dynamoTestUtils";

describe("createDynamoPlayerRepository behavior", () => {
  let repo: ReturnType<typeof createDynamoPlayerRepository>;

  beforeEach(() => {
    const docClient = createDocClientFake();
    const cfg = newTestConfig(docClient);
    repo = createDynamoPlayerRepository(cfg);
  });

  it("create/get/list happy path", async () => {
    // none at start
    expect(await repo.listPlayers("rid-1")).toEqual([]);

    // create
    await repo.createPlayer(samplePlayer());

    // get by id
    const found = await repo.getPlayer("rid-1", "pid-1");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("Alice");

    // list
    const list = await repo.listPlayers("rid-1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ playerId: "pid-1", name: "Alice" });
  });

  it("createPlayer rejects when player already exists (conditional failure)", async () => {
    await repo.createPlayer(samplePlayer());
    await expect(repo.createPlayer(samplePlayer())).rejects.toBeTruthy();
  });

  it("updatePlayer overwrites fields", async () => {
    await repo.createPlayer(samplePlayer());
    await repo.updatePlayer(samplePlayer({ name: "Bob", color: "#123456" }));

    const found = await repo.getPlayer("rid-1", "pid-1");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("Bob");
    expect(found!.color).toBe("#123456");
  });

  it("getPlayer returns null when missing", async () => {
    const out = await repo.getPlayer("rid-1", "nope");
    expect(out).toBeNull();
  });

  it("listPlayers returns empty when none exist", async () => {
    const out = await repo.listPlayers("rid-2");
    expect(out).toEqual([]);
  });
});
