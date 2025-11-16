import {
  createRoundConfig,
  createInitialRoundState,
  isValidHoleNumber,
} from "@swng/domain";
import type { RoundState, Player, Score, RoundSnapshot } from "@swng/domain";
import { ApplicationError } from "./errors";
import type {
  RoundService,
  RoundServiceDeps,
  CreateRoundInput,
  CreateRoundOutput,
  JoinRoundInput,
  JoinRoundOutput,
  GetRoundInput,
  GetRoundOutput,
  UpdateScoreInput,
  UpdateScoreOutput,
  PatchRoundStateInput,
  PatchRoundStateOutput,
  UpdatePlayerInput,
  UpdatePlayerOutput,
  Session,
} from "./types";

export function createRoundService(deps: RoundServiceDeps): RoundService {
  const {
    roundRepo,
    playerRepo,
    scoreRepo,
    sessionRepo,
    idGenerator,
    clock,
    config,
  } = deps;

  const defaultColor = "#000000";

  async function ensureSessionForRound(
    roundId: string,
    sessionId: string
  ): Promise<Session> {
    const session = await sessionRepo.getSession(sessionId);
    if (!session) {
      throw new ApplicationError("UNAUTHORIZED", "Session not found");
    }
    if (session.roundId !== roundId) {
      throw new ApplicationError(
        "UNAUTHORIZED",
        "Session does not belong to this round"
      );
    }
    return session;
  }

  async function loadRoundSnapshot(roundId: string): Promise<RoundSnapshot> {
    const snapshot = await roundRepo.getRoundSnapshot(roundId);

    if (!snapshot) {
      throw new ApplicationError("NOT_FOUND", "Round not found");
    }

    return snapshot;
  }

  return {
    async createRound(input: CreateRoundInput): Promise<CreateRoundOutput> {
      const { courseName, par } = input;

      if (par.length === 0) {
        throw new ApplicationError(
          "INVALID_INPUT",
          "par array must be non-empty"
        );
      }

      const roundId = idGenerator.newRoundId();
      const accessCode = idGenerator.newAccessCode();
      const createdAt = clock.now();

      const configValue = createRoundConfig({
        roundId,
        accessCode,
        courseName,
        par,
        createdAt,
      });

      const stateValue = createInitialRoundState(roundId, createdAt);

      await roundRepo.saveConfig(configValue);
      await roundRepo.saveState(stateValue);

      return {
        config: configValue,
        state: stateValue,
      };
    },

    async joinRound(input: JoinRoundInput): Promise<JoinRoundOutput> {
      const { accessCode, playerName, color } = input;

      const result = await roundRepo.getRoundSnapshotByAccessCode(accessCode);
      if (!result) {
        throw new ApplicationError("NOT_FOUND", "Round not found");
      }

      const { roundId, snapshot } = result;
      const { config: roundConfig, state, players, scores } = snapshot;

      const now = clock.now();
      const playerId = idGenerator.newPlayerId();

      const player: Player = {
        roundId,
        playerId,
        name: playerName,
        color: color ?? defaultColor,
        joinedAt: now,
        updatedAt: now,
      };

      await playerRepo.createPlayer(player);

      const sessionId = idGenerator.newSessionId();
      const expiresAt = computeExpiry(now, config.sessionTtlMs);

      const session: Session = {
        sessionId,
        roundId,
        playerId,
        expiresAt,
      };

      await sessionRepo.createSession(session);

      const updatedSnapshot: RoundSnapshot = {
        config: roundConfig,
        state,
        players: [...players, player],
        scores,
      };

      return {
        roundId,
        player,
        sessionId,
        snapshot: updatedSnapshot,
      };
    },

    async getRound(input: GetRoundInput): Promise<GetRoundOutput> {
      const { roundId, sessionId } = input;

      await ensureSessionForRound(roundId, sessionId);

      const snapshot = await loadRoundSnapshot(roundId);

      return { snapshot };
    },

    async updateScore(input: UpdateScoreInput): Promise<UpdateScoreOutput> {
      const { roundId, sessionId, playerId, holeNumber, strokes } = input;

      const session = await ensureSessionForRound(roundId, sessionId);

      const snapshot = await roundRepo.getRoundSnapshot(roundId);
      if (!snapshot) {
        throw new ApplicationError("NOT_FOUND", "Round not found");
      }

      const { config: roundConfig } = snapshot;

      if (!isValidHoleNumber(roundConfig, holeNumber)) {
        throw new ApplicationError(
          "INVALID_INPUT",
          `Hole number ${holeNumber} is not valid for this round`
        );
      }

      if (!Number.isInteger(strokes) || strokes <= 0) {
        throw new ApplicationError(
          "INVALID_INPUT",
          `Strokes must be a positive integer, got: ${strokes}`
        );
      }

      const now = clock.now();

      const score: Score = {
        roundId,
        playerId,
        holeNumber,
        strokes,
        updatedBy: session.playerId,
        updatedAt: now,
      };

      await scoreRepo.upsertScore(score);

      return { score };
    },

    async patchRoundState(
      input: PatchRoundStateInput
    ): Promise<PatchRoundStateOutput> {
      const { roundId, sessionId, currentHole, status } = input;

      await ensureSessionForRound(roundId, sessionId);

      const snapshot = await roundRepo.getRoundSnapshot(roundId);
      if (!snapshot) {
        throw new ApplicationError("NOT_FOUND", "Round not found");
      }

      const { config: roundConfig, state: stateValue } = snapshot;

      let nextCurrentHole = stateValue.currentHole;

      if (currentHole !== undefined) {
        if (!isValidHoleNumber(roundConfig, currentHole)) {
          throw new ApplicationError(
            "INVALID_INPUT",
            `Hole number ${currentHole} is not valid for this round`
          );
        }
        nextCurrentHole = currentHole;
      }

      const nextStatus = status !== undefined ? status : stateValue.status;

      const now = clock.now();
      const nextStateVersion = stateValue.stateVersion + 1;

      const updatedState: RoundState = {
        roundId,
        currentHole: nextCurrentHole,
        status: nextStatus,
        stateVersion: nextStateVersion,
        updatedAt: now,
      };

      await roundRepo.saveState(updatedState);

      return { state: updatedState };
    },

    async updatePlayer(input: UpdatePlayerInput): Promise<UpdatePlayerOutput> {
      const { roundId, sessionId, playerId, name, color } = input;

      await ensureSessionForRound(roundId, sessionId);

      const existing = await playerRepo.getPlayer(roundId, playerId);
      if (!existing) {
        throw new ApplicationError("NOT_FOUND", "Player not found");
      }

      const now = clock.now();

      const updated: Player = {
        ...existing,
        name: name ?? existing.name,
        color: color ?? existing.color,
        updatedAt: now,
      };

      await playerRepo.updatePlayer(updated);

      return { player: updated };
    },
  };
}

function computeExpiry(nowIso: string, ttlMs: number): string {
  const now = new Date(nowIso).getTime();
  const expires = new Date(now + ttlMs);
  return expires.toISOString();
}
