import type {
  IsoDateTime,
  Player,
  PlayerId,
  RoundConfig,
  RoundId,
  RoundSnapshot,
  RoundState,
  Score,
  RoundStatus,
} from "@swng/domain";

export interface RoundRepository {
  getRoundSnapshot(roundId: RoundId): Promise<RoundSnapshot | null>;
  getRoundSnapshotByAccessCode(
    accessCode: string
  ): Promise<{ roundId: RoundId; snapshot: RoundSnapshot } | null>;

  saveConfig(config: RoundConfig): Promise<void>;
  saveState(state: RoundState): Promise<void>;
}

export interface PlayerRepository {
  createPlayer(player: Player): Promise<void>;
  updatePlayer(player: Player): Promise<void>;
  getPlayer(roundId: RoundId, playerId: PlayerId): Promise<Player | null>;
  listPlayers(roundId: RoundId): Promise<Player[]>;
}

export interface ScoreRepository {
  upsertScore(score: Score): Promise<void>;
  listScores(roundId: RoundId): Promise<Score[]>;
}

export interface Session {
  sessionId: string;
  roundId: RoundId;
  playerId: PlayerId;
  expiresAt: IsoDateTime;
}

export interface SessionRepository {
  getSession(sessionId: string): Promise<Session | null>;
  createSession(session: Session): Promise<void>;
}

export interface Connection {
  roundId: RoundId;
  connectionId: string;
  playerId: PlayerId;
  connectedAt: IsoDateTime;
}

export interface ConnectionRepository {
  addConnection(connection: Connection, ttlSeconds?: number): Promise<void>;
  removeConnection(roundId: RoundId, connectionId: string): Promise<void>;
  listConnections(roundId: RoundId): Promise<Connection[]>;
}

export interface BroadcastPort {
  broadcastPlayerJoined(roundId: RoundId, player: Player): Promise<void>;
  broadcastPlayerUpdated(roundId: RoundId, player: Player): Promise<void>;
  broadcastScoreChanged(roundId: RoundId, score: Score): Promise<void>;
  broadcastRoundStateChanged(
    roundId: RoundId,
    state: RoundState
  ): Promise<void>;
}

export interface Clock {
  now(): IsoDateTime;
}

export interface IdGenerator {
  newRoundId(): RoundId;
  newPlayerId(): PlayerId;
  newSessionId(): string;
  newAccessCode(): string;
}

export interface RoundServiceConfig {
  sessionTtlMs: number;
}

export interface RoundServiceDeps {
  roundRepo: RoundRepository;
  playerRepo: PlayerRepository;
  scoreRepo: ScoreRepository;
  sessionRepo: SessionRepository;

  idGenerator: IdGenerator;
  clock: Clock;
  config: RoundServiceConfig;
}

export interface CreateRoundInput {
  courseName: string;
  par: number[];
}

export interface CreateRoundOutput {
  config: RoundConfig;
  state: RoundState;
}

export interface JoinRoundInput {
  accessCode: string;
  playerName: string;
  color?: string;
}

export interface JoinRoundOutput {
  roundId: RoundId;
  player: Player;
  sessionId: string;
  snapshot: RoundSnapshot;
}

export interface GetRoundInput {
  roundId: RoundId;
  sessionId: string;
}

export interface GetRoundOutput {
  snapshot: RoundSnapshot;
}

export interface UpdateScoreInput {
  roundId: RoundId;
  sessionId: string;
  playerId: PlayerId;
  holeNumber: number;
  strokes: number;
}

export interface UpdateScoreOutput {
  score: Score;
}

export interface PatchRoundStateInput {
  roundId: RoundId;
  sessionId: string;
  currentHole?: number;
  status?: RoundStatus | null;
}

export interface PatchRoundStateOutput {
  state: RoundState;
}

export interface UpdatePlayerInput {
  roundId: RoundId;
  sessionId: string;
  playerId: PlayerId;
  name?: string;
  color?: string;
}

export interface UpdatePlayerOutput {
  player: Player;
}

export interface RoundService {
  createRound(input: CreateRoundInput): Promise<CreateRoundOutput>;
  joinRound(input: JoinRoundInput): Promise<JoinRoundOutput>;
  getRound(input: GetRoundInput): Promise<GetRoundOutput>;
  updateScore(input: UpdateScoreInput): Promise<UpdateScoreOutput>;
  patchRoundState(input: PatchRoundStateInput): Promise<PatchRoundStateOutput>;
  updatePlayer(input: UpdatePlayerInput): Promise<UpdatePlayerOutput>;
}
