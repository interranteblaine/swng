/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRoundService } from "../application/roundService";
import { RoundServiceDeps } from "../application/types";
import { ApplicationError } from "../application/errors";
import type {
  RoundConfig,
  RoundState,
  RoundSnapshot,
  Player,
  Score,
  RoundStatus,
} from "@swng/domain";

function createTestDeps(): {
  deps: RoundServiceDeps;
  stores: {
    configs: RoundConfig[];
    states: RoundState[];
    players: Player[];
    sessions: Record<
      string,
      {
        sessionId: string;
        roundId: string;
        playerId: string;
        expiresAt: string;
      }
    >;
    scores: Score[];
  };
} {
  const configs: RoundConfig[] = [];
  const states: RoundState[] = [];
  const players: Player[] = [];
  const sessions: Record<
    string,
    { sessionId: string; roundId: string; playerId: string; expiresAt: string }
  > = {};
  const scores: Score[] = [];

  const roundRepo = {
    getRoundSnapshot: async (roundId: string) => {
      if (!configs.length) return null;
      const config = configs[0];
      if (config.roundId !== roundId) return null;
      const state = states[0];
      return { config, state, players, scores };
    },
    getRoundSnapshotByAccessCode: async (accessCode: string) => {
      const cfg = configs.find((c) => c.accessCode === accessCode);
      if (!cfg) return null;
      const snapshot: RoundSnapshot = {
        config: cfg,
        state: states[0],
        players,
        scores,
      };
      return { roundId: cfg.roundId, snapshot };
    },
    saveConfig: async (config: RoundConfig) => {
      configs.push(config);
    },
    saveState: async (state: RoundState, expectedVersion?: number) => {
      // Simulate optimistic concurrency: if an expectedVersion is provided,
      // require it to match the latest persisted state's version.
      if (expectedVersion !== undefined) {
        const last = states[states.length - 1];
        if (!last || last.stateVersion !== expectedVersion) {
          throw new ApplicationError(
            "CONFLICT",
            "State version mismatch (test stub)"
          );
        }
      }
      states.push(state);
    },
  };

  const playerRepo = {
    createPlayer: async (player: Player) => {
      players.push(player);
    },
    updatePlayer: async (player: Player) => {
      const idx = players.findIndex((p) => p.playerId === player.playerId);
      if (idx >= 0) players[idx] = player;
    },
    getPlayer: async (roundId: string, playerId: string) => {
      return (
        players.find((p) => p.roundId === roundId && p.playerId === playerId) ??
        null
      );
    },
    listPlayers: async () => players,
  };

  const scoreRepo = {
    upsertScore: async (score: Score) => {
      const idx = scores.findIndex(
        (s) =>
          s.playerId === score.playerId && s.holeNumber === score.holeNumber
      );
      if (idx >= 0) scores[idx] = score;
      else scores.push(score);
    },
    listScores: async () => scores,
  };

  const sessionRepo = {
    getSession: async (sessionId: string) => sessions[sessionId] ?? null,
    createSession: async (session: {
      sessionId: string;
      roundId: string;
      playerId: string;
      expiresAt: string;
    }) => {
      sessions[session.sessionId] = session;
    },
  };

  const idGenerator = {
    newRoundId: () => "rid-1",
    newAccessCode: () => "code-1",
    newPlayerId: () => `pid-${players.length + 1}`,
    newSessionId: () => `sid-${Object.keys(sessions).length + 1}`,
  };

  const clock = {
    now: () => "2025-11-16T00:00:00.000Z",
  };

  const config = { sessionTtlMs: 1000 * 60 * 60 };
  const broadcastNotify = vi.fn(async (_roundId: string, _msg: unknown) => {});
  const broadcast = { notify: broadcastNotify };

  return {
    deps: {
      roundRepo,
      playerRepo,
      scoreRepo,
      sessionRepo,
      idGenerator,
      clock,
      config,
      broadcast,
    },
    stores: { configs, states, players, sessions, scores },
  };
}

describe("RoundService Behavior", () => {
  let deps: RoundServiceDeps;
  let stores: ReturnType<typeof createTestDeps>["stores"];
  let service: ReturnType<typeof createRoundService>;

  beforeEach(() => {
    const created = createTestDeps();
    deps = created.deps;
    stores = created.stores;
    service = createRoundService(deps);
  });

  describe("createRound", () => {
    it("rejects empty par array", async () => {
      await expect(
        service.createRound({ courseName: "C", par: [] })
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "par array must be non-empty",
      });
    });

    it("creates and persists config and initial state", async () => {
      const par = [3, 4, 5];
      const result = await service.createRound({ courseName: "Test", par });
      const cfg = stores.configs[0];
      const st = stores.states[0];

      expect(cfg.courseName).toBe("Test");
      expect(cfg.par).toEqual(par);
      expect(st.currentHole).toBe(1);
      expect(st.stateVersion).toBe(1);
      expect(result.config).toEqual(cfg);
      expect(result.state).toEqual(st);
    });
  });

  describe("joinRound", () => {
    beforeEach(async () => {
      await service.createRound({ courseName: "R", par: [3, 4] });
    });

    it("rejects unknown access code", async () => {
      await expect(
        service.joinRound({ accessCode: "bad", playerName: "A" })
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Round not found",
      });
    });

    it("registers player and session and returns updated snapshot", async () => {
      const { roundId } = stores.configs[0];
      const res = await service.joinRound({
        accessCode: "code-1",
        playerName: "Alice",
        color: "#abc",
      });

      expect(res.roundId).toBe(roundId);
      expect(res.player.name).toBe("Alice");
      expect(res.player.color).toBe("#abc");
      expect(Object.keys(stores.sessions)).toHaveLength(1);
      expect(stores.players).toHaveLength(1);
      expect(res.snapshot.players).toContainEqual(res.player);
    });

    it("uses default color when none provided", async () => {
      const { player } = await service.joinRound({
        accessCode: stores.configs[0].accessCode,
        playerName: "NoColorUser",
      });
      expect(player.color).toBe("#000000");
    });

    it("emits notify with PlayerJoined", async () => {
      const before = (deps.broadcast as any).notify.mock.calls.length;
      await service.joinRound({
        accessCode: "code-1",
        playerName: "EmitUser",
      });
      const calls = (deps.broadcast as any).notify.mock.calls;
      expect(calls.length).toBeGreaterThan(before);
      const last = calls[calls.length - 1];
      expect(last[1]?.type).toBe("PlayerJoined");
    });
  });

  describe("getRound", () => {
    beforeEach(async () => {
      await service.createRound({ courseName: "R", par: [3] });
      await service.joinRound({ accessCode: "code-1", playerName: "Bob" });
    });

    it("rejects missing session", async () => {
      await expect(
        service.getRound({ roundId: "rid-1", sessionId: "nope" })
      ).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        message: "Session not found",
      });
    });

    it("rejects session for other round", async () => {
      // tamper session
      const sid = Object.keys(stores.sessions)[0];
      stores.sessions[sid].roundId = "other";
      await expect(
        service.getRound({ roundId: "rid-1", sessionId: sid })
      ).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        message: "Session does not belong to this round",
      });
    });

    it("returns snapshot when authorized", async () => {
      const sid = Object.keys(stores.sessions)[0];
      const { snapshot } = await service.getRound({
        roundId: "rid-1",
        sessionId: sid,
      });
      expect(snapshot.config.roundId).toBe("rid-1");
    });

    it("throws NOT_FOUND if snapshot is missing", async () => {
      stores.configs.length = 0;
      stores.states.length = 0;
      const sid = Object.keys(stores.sessions)[0];
      await expect(
        service.getRound({ roundId: "rid-1", sessionId: sid })
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Round not found",
      });
    });
  });

  describe("updateScore", () => {
    beforeEach(async () => {
      await service.createRound({ courseName: "R", par: [3, 4] });
      await service.joinRound({ accessCode: "code-1", playerName: "P1" });
    });

    it("rejects non-existing round/session mismatch", async () => {
      await expect(
        service.updateScore({
          roundId: "bad",
          sessionId: "sid-1",
          playerId: "pid-1",
          holeNumber: 1,
          strokes: 1,
        })
      ).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        message: "Session does not belong to this round",
      });
    });

    it("rejects invalid holeNumber", async () => {
      await expect(
        service.updateScore({
          roundId: "rid-1",
          sessionId: "sid-1",
          playerId: "pid-1",
          holeNumber: 99,
          strokes: 1,
        })
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });

    it("rejects non-positive strokes", async () => {
      await expect(
        service.updateScore({
          roundId: "rid-1",
          sessionId: "sid-1",
          playerId: "pid-1",
          holeNumber: 1,
          strokes: 0,
        })
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });

    it("upserts and returns score", async () => {
      const out = await service.updateScore({
        roundId: "rid-1",
        sessionId: "sid-1",
        playerId: "pid-1",
        holeNumber: 2,
        strokes: 3,
      });
      expect(stores.scores).toHaveLength(1);
      expect(out.score.strokes).toBe(3);
      expect(out.score.updatedBy).toBe("pid-1");
    });

    it("emits notify with ScoreChanged", async () => {
      const before = (deps.broadcast as any).notify.mock.calls.length;
      await service.updateScore({
        roundId: "rid-1",
        sessionId: "sid-1",
        playerId: "pid-1",
        holeNumber: 1,
        strokes: 2,
      });
      const calls = (deps.broadcast as any).notify.mock.calls;
      expect(calls.length).toBeGreaterThan(before);
      const last = calls[calls.length - 1];
      expect(last[1]?.type).toBe("ScoreChanged");
    });

    it("throws NOT_FOUND if snapshot is missing", async () => {
      stores.configs.length = 0;
      stores.states.length = 0;
      await expect(
        service.updateScore({
          roundId: "rid-1",
          sessionId: "sid-1",
          playerId: "pid-1",
          holeNumber: 1,
          strokes: 1,
        })
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Round not found",
      });
    });
  });

  describe("patchRoundState", () => {
    beforeEach(async () => {
      await service.createRound({ courseName: "R", par: [3, 4] });
      await service.joinRound({ accessCode: "code-1", playerName: "P" });
    });

    it("rejects non-existing round/session mismatch", async () => {
      await expect(
        service.patchRoundState({ roundId: "bad", sessionId: "sid-1" })
      ).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        message: "Session does not belong to this round",
      });
    });

    it("rejects invalid hole update", async () => {
      await expect(
        service.patchRoundState({
          roundId: "rid-1",
          sessionId: "sid-1",
          currentHole: 99,
        })
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });

    it("updates hole and status as provided", async () => {
      const out = await service.patchRoundState({
        roundId: "rid-1",
        sessionId: "sid-1",
        currentHole: 2,
        status: "completed" as RoundStatus,
      });
      expect(stores.states[1].currentHole).toBe(2);
      expect(out.state.status).toBe("completed");
    });

    it("throws NOT_FOUND if snapshot is missing", async () => {
      stores.configs.length = 0;
      stores.states.length = 0;
      await expect(
        service.patchRoundState({ roundId: "rid-1", sessionId: "sid-1" })
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Round not found",
      });
    });

    it("leaves unspecified fields unchanged", async () => {
      const initial = stores.states[0];
      const out = await service.patchRoundState({
        roundId: "rid-1",
        sessionId: "sid-1",
      });
      expect(out.state.currentHole).toBe(initial.currentHole);
      expect(out.state.status).toBe(initial.status);
    });

    it("allows status to be explicitly set to null", async () => {
      const res = await service.patchRoundState({
        roundId: "rid-1",
        sessionId: "sid-1",
        status: null,
      });
      expect(res.state.status).toBeNull();
    });

    it("propagates CONFLICT when repository detects a concurrent update", async () => {
      // First update succeeds; our stub getRoundSnapshot returns the initial state (states[0])
      // which simulates a stale read on subsequent calls.
      await service.patchRoundState({
        roundId: "rid-1",
        sessionId: "sid-1",
        currentHole: 2,
      });

      // Second update reads the same stale version (states[0]) and thus provides expectedVersion=1,
      // but the latest persisted state's version is now 2, causing the stub to throw CONFLICT.
      await expect(
        service.patchRoundState({
          roundId: "rid-1",
          sessionId: "sid-1",
        })
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });
  });

  describe("updatePlayer", () => {
    beforeEach(async () => {
      await service.createRound({ courseName: "R", par: [3] });
      await service.joinRound({ accessCode: "code-1", playerName: "X" });
    });

    it("rejects missing player", async () => {
      await expect(
        service.updatePlayer({
          roundId: "rid-1",
          sessionId: "sid-1",
          playerId: "nope",
        })
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Player not found",
      });
    });

    it("updates provided fields only", async () => {
      const pid = stores.players[0].playerId;
      const updated = await service.updatePlayer({
        roundId: "rid-1",
        sessionId: "sid-1",
        playerId: pid,
        name: "Y",
        color: "#123",
      });
      expect(updated.player.name).toBe("Y");
      expect(updated.player.color).toBe("#123");
      expect(updated.player.updatedAt).toBe(deps.clock.now());
    });

    it("keeps existing when no updates specified", async () => {
      const orig = stores.players[0];
      const result = await service.updatePlayer({
        roundId: "rid-1",
        sessionId: "sid-1",
        playerId: orig.playerId,
      });
      expect(result.player.name).toBe(orig.name);
      expect(result.player.color).toBe(orig.color);
    });
  });
});
