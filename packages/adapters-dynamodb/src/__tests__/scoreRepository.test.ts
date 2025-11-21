import { describe, it, expect, beforeEach } from "vitest";
import { createDynamoScoreRepository } from "../adapters-dynamodb/scoreRepository";
import {
  createDocClientFake,
  newTestConfig,
  sampleScore,
} from "./dynamoTestUtils";

describe("createDynamoScoreRepository behavior", () => {
  let repo: ReturnType<typeof createDynamoScoreRepository>;

  beforeEach(() => {
    const docClient = createDocClientFake();
    const cfg = newTestConfig(docClient);
    repo = createDynamoScoreRepository(cfg);
  });

  describe("listScores", () => {
    it("returns empty list when none exist", async () => {
      const out = await repo.listScores("rid-1");
      expect(out).toEqual([]);
    });
  });

  describe("upsertScore", () => {
    it("inserts a new score and it appears in list", async () => {
      await repo.upsertScore(sampleScore()); // rid-1, pid-1, hole 1, strokes 3

      const list = await repo.listScores("rid-1");
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        playerId: "pid-1",
        holeNumber: 1,
        strokes: 3,
      });
    });

    it("overwrites an existing score for same player/hole (last write wins)", async () => {
      await repo.upsertScore(sampleScore({ strokes: 3 })); // initial
      await repo.upsertScore(sampleScore({ strokes: 5 })); // overwrite same (pid-1, hole 1)

      const list = await repo.listScores("rid-1");
      expect(list).toHaveLength(1);
      expect(list[0].strokes).toBe(5);
    });

    it("keeps separate scores for different holes/players", async () => {
      await repo.upsertScore(
        sampleScore({ playerId: "pid-1", holeNumber: 1, strokes: 3 })
      );
      await repo.upsertScore(
        sampleScore({ playerId: "pid-1", holeNumber: 2, strokes: 4 })
      );
      await repo.upsertScore(
        sampleScore({ playerId: "pid-2", holeNumber: 1, strokes: 2 })
      );

      const list = await repo.listScores("rid-1");
      expect(list).toHaveLength(3);
      expect(list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            playerId: "pid-1",
            holeNumber: 1,
            strokes: 3,
          }),
          expect.objectContaining({
            playerId: "pid-1",
            holeNumber: 2,
            strokes: 4,
          }),
          expect.objectContaining({
            playerId: "pid-2",
            holeNumber: 1,
            strokes: 2,
          }),
        ])
      );
    });

    it("does not return scores from another round", async () => {
      // Insert a score in rid-1 and a score in rid-2
      await repo.upsertScore(
        sampleScore({ roundId: "rid-1", playerId: "pid-1", holeNumber: 1 })
      );
      await repo.upsertScore(
        sampleScore({ roundId: "rid-2", playerId: "pid-9", holeNumber: 1 })
      );

      const list1 = await repo.listScores("rid-1");
      const list2 = await repo.listScores("rid-2");

      expect(list1).toHaveLength(1);
      expect(list1[0]).toMatchObject({ roundId: "rid-1", playerId: "pid-1" });

      expect(list2).toHaveLength(1);
      expect(list2[0]).toMatchObject({ roundId: "rid-2", playerId: "pid-9" });
    });
  });
});
