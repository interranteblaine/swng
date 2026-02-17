export type RoundId = string;
export type PlayerId = string;
export type CourseId = string;
export type IsoDateTime = string;

export type RoundStatus = "IN_PROGRESS" | "COMPLETED";

export interface TeeHole {
  holeNumber: number;
  par: number;
  yardage: number;
  handicapIndex: number;
}

export interface TeeSet {
  name: string;
  color: string;
  courseRating: number;
  slopeRating: number;
  holes: TeeHole[];
}

export interface Course {
  courseId: CourseId;
  name: string;
  location?: string;
  holeCount: number;
  teeSets: TeeSet[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CourseSnapshot {
  courseId: CourseId;
  name: string;
  location?: string;
  holeCount: number;
  teeSets: TeeSet[];
}

export interface RoundConfig {
  roundId: RoundId;
  accessCode: string;
  createdAt: IsoDateTime;
  course: CourseSnapshot;
}

export interface RoundState {
  roundId: RoundId;
  status: RoundStatus | null;
  stateVersion: number; // monotonically increasing
  updatedAt: IsoDateTime;
}

export interface Player {
  roundId: RoundId;
  playerId: PlayerId;
  name: string;
  color: string;
  joinedAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface Score {
  roundId: RoundId;
  playerId: PlayerId;
  holeNumber: number; // 1-based
  strokes: number;
  updatedBy: PlayerId;
  updatedAt: IsoDateTime;
}

export interface RoundSnapshot {
  config: RoundConfig;
  state: RoundState;
  players: Player[];
  scores: Score[];
}

export type DomainEvent =
  | PlayerJoinedEvent
  | PlayerUpdatedEvent
  | PlayerRemovedEvent
  | ScoreChangedEvent
  | ScoreClearedEvent
  | RoundStateChangedEvent;

export interface BaseEvent {
  roundId: RoundId;
  occurredAt: IsoDateTime;
}

export interface PlayerJoinedEvent extends BaseEvent {
  type: "PlayerJoined";
  player: Player;
}

export interface PlayerUpdatedEvent extends BaseEvent {
  type: "PlayerUpdated";
  player: Player;
}

export interface PlayerRemovedEvent extends BaseEvent {
  type: "PlayerRemoved";
  playerId: PlayerId;
}

export interface ScoreChangedEvent extends BaseEvent {
  type: "ScoreChanged";
  score: Score;
}

export interface ScoreClearedEvent extends BaseEvent {
  type: "ScoreCleared";
  playerId: PlayerId;
  holeNumber: number;
}

export interface RoundStateChangedEvent extends BaseEvent {
  type: "RoundStateChanged";
  state: RoundState;
}
