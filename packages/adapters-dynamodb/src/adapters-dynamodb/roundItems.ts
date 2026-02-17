import type {
  CourseSnapshot,
  RoundConfig,
  RoundId,
  RoundState,
  IsoDateTime,
} from "@swng/domain";
import { CONFIG_SK, STATE_SK, roundPk } from "./keys";

export interface RoundConfigItem {
  PK: string;
  SK: typeof CONFIG_SK;
  GSI1PK: string;
  GSI1SK: string;
  roundId: RoundId;
  accessCode: string;
  createdAt: IsoDateTime;
  course: CourseSnapshot;
}

export interface RoundStateItem {
  PK: string;
  SK: typeof STATE_SK;
  roundId: RoundId;
  status: RoundState["status"];
  stateVersion: number;
  updatedAt: IsoDateTime;
}

export function toConfigItem(config: RoundConfig): RoundConfigItem {
  return {
    PK: roundPk(config.roundId),
    SK: CONFIG_SK,
    GSI1PK: `CODE#${config.accessCode}`,
    GSI1SK: `ROUND#${config.roundId}`,
    roundId: config.roundId,
    accessCode: config.accessCode,
    createdAt: config.createdAt,
    course: config.course,
  };
}

export function fromConfigItem(item: RoundConfigItem): RoundConfig {
  return {
    roundId: item.roundId,
    accessCode: item.accessCode,
    createdAt: item.createdAt,
    course: item.course,
  };
}

export function toStateItem(state: RoundState): RoundStateItem {
  return {
    PK: roundPk(state.roundId),
    SK: STATE_SK,
    roundId: state.roundId,
    status: state.status,
    stateVersion: state.stateVersion,
    updatedAt: state.updatedAt,
  };
}

export function fromStateItem(item: RoundStateItem): RoundState {
  return {
    roundId: item.roundId,
    status: item.status,
    stateVersion: item.stateVersion,
    updatedAt: item.updatedAt,
  };
}
