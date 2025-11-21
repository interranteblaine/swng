import { describe, it, expect, beforeEach } from "vitest";
import { createDynamoRoundRepository } from "../adapters-dynamodb/roundRepository";
import { createDynamoPlayerRepository } from "../adapters-dynamodb/playerRepository";
import { createDynamoScoreRepository } from "../adapters-dynamodb/scoreRepository";
import {
  newTestConfig,
  createDocClientFake,
  sampleRoundConfig,
  sampleRoundState,
  samplePlayer,
  sampleScore,
} from "./dynamoTestUtils";

describe("createDynamoRoundRepository behavior", () => {
  let config: ReturnType<typeof newTestConfig>;
  let roundRepo: ReturnType<typeof createDynamoRoundRepository>;
  let playerRepo: ReturnType<typeof createDynamoPlayerRepository>;
  let scoreRepo: ReturnType<typeof createDynamoScoreRepository>;

  beforeEach(() => {
    const docClient = createDocClientFake();
    config = newTestConfig(docClient);
    roundRepo = createDynamoRoundRepository(config);
    playerRepo = createDynamoPlayerRepository(config);
    scoreRepo = createDynamoScoreRepository(config);
  });

  describe("getRoundSnapshot", () => {
    it("returns null when no items exist", async () => {
      const out = await roundRepo.getRoundSnapshot("rid-1");
      expect(out).toBeNull();
    });

    it("returns null when CONFIG exists but STATE is missing", async () => {
      await roundRepo.saveConfig(sampleRoundConfig());
      const out = await roundRepo.getRoundSnapshot("rid-1");
      expect(out).toBeNull();
    });

    it("returns null when STATE exists but CONFIG is missing", async () => {
      await roundRepo.saveState(sampleRoundState());
      const out = await roundRepo.getRoundSnapshot("rid-1");
      expect(out).toBeNull();
    });

    it("returns snapshot composed of config, state, players, and scores", async () => {
      await roundRepo.saveConfig(sampleRoundConfig());
      await roundRepo.saveState(sampleRoundState());
      await playerRepo.createPlayer(samplePlayer());
      await scoreRepo.upsertScore(sampleScore());

      const out = await roundRepo.getRoundSnapshot("rid-1");
      expect(out).not.toBeNull();
      expect(out!.config.roundId).toBe("rid-1");
      expect(out!.state.roundId).toBe("rid-1");
      expect(out!.players).toEqual([
        expect.objectContaining({ playerId: "pid-1", name: "Alice" }),
      ]);
      expect(out!.scores).toEqual([
        expect.objectContaining({
          playerId: "pid-1",
          holeNumber: 1,
          strokes: 3,
        }),
      ]);
    });
  });

  describe("getRoundSnapshotByAccessCode", () => {
    it("returns null when no config found for access code", async () => {
      const res = await roundRepo.getRoundSnapshotByAccessCode("missing");
      expect(res).toBeNull();
    });

    it("returns null when config found but snapshot cannot be built (missing STATE)", async () => {
      await roundRepo.saveConfig(
        sampleRoundConfig({ accessCode: "code-1", roundId: "rid-1" })
      );
      const res = await roundRepo.getRoundSnapshotByAccessCode("code-1");
      expect(res).toBeNull();
    });

    it("returns { roundId, snapshot } when found", async () => {
      await roundRepo.saveConfig(
        sampleRoundConfig({ accessCode: "code-1", roundId: "rid-1" })
      );
      await roundRepo.saveState(sampleRoundState({ roundId: "rid-1" }));
      await playerRepo.createPlayer(samplePlayer());
      const res = await roundRepo.getRoundSnapshotByAccessCode("code-1");
      expect(res).not.toBeNull();
      expect(res!.roundId).toBe("rid-1");
      expect(res!.snapshot.config.roundId).toBe("rid-1");
      expect(res!.snapshot.players.length).toBe(1);
    });
  });

  describe("saveConfig", () => {
    it("persists config and can be read via getRoundSnapshot once state exists", async () => {
      await roundRepo.saveConfig(sampleRoundConfig());
      await roundRepo.saveState(sampleRoundState());
      const out = await roundRepo.getRoundSnapshot("rid-1");
      expect(out!.config.courseName).toBe("Course");
      expect(out!.config.par).toEqual([3, 4, 5]);
    });
  });

  describe("saveState (optimistic concurrency)", () => {
    it("initial write succeeds when state does not yet exist", async () => {
      await roundRepo.saveConfig(sampleRoundConfig());
      await roundRepo.saveState(sampleRoundState());
      const out = await roundRepo.getRoundSnapshot("rid-1");
      expect(out!.state.stateVersion).toBe(1);
    });

    it("initial write throws CONFLICT when state already exists", async () => {
      await roundRepo.saveState(sampleRoundState());
      await expect(
        roundRepo.saveState(sampleRoundState())
      ).rejects.toMatchObject({
        code: "CONFLICT",
      });
    });

    it("update succeeds when expectedVersion matches current version", async () => {
      await roundRepo.saveConfig(sampleRoundConfig());
      await roundRepo.saveState(sampleRoundState({ stateVersion: 1 }));
      // Move to version 2 with expectedVersion=1
      await roundRepo.saveState(sampleRoundState({ stateVersion: 2 }), 1);
      const out = await roundRepo.getRoundSnapshot("rid-1");
      expect(out!.state.stateVersion).toBe(2);
    });

    it("update throws CONFLICT when expectedVersion mismatches", async () => {
      await roundRepo.saveState(sampleRoundState({ stateVersion: 1 }));
      await expect(
        roundRepo.saveState(sampleRoundState({ stateVersion: 2 }), 999)
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });
  });
});
