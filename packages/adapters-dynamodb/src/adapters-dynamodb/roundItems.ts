import type {
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
  courseName: string;
  holes: number;
  par: number[];
  createdAt: IsoDateTime;
}

export interface RoundStateItem {
  PK: string;
  SK: typeof STATE_SK;
  roundId: RoundId;
  currentHole: number;
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
    courseName: config.courseName,
    holes: config.holes,
    par: [...config.par],
    createdAt: config.createdAt,
  };
}

export function fromConfigItem(item: RoundConfigItem): RoundConfig {
  return {
    roundId: item.roundId,
    accessCode: item.accessCode,
    courseName: item.courseName,
    holes: item.holes,
    par: item.par,
    createdAt: item.createdAt,
  };
}

export function toStateItem(state: RoundState): RoundStateItem {
  return {
    PK: roundPk(state.roundId),
    SK: STATE_SK,
    roundId: state.roundId,
    currentHole: state.currentHole,
    status: state.status,
    stateVersion: state.stateVersion,
    updatedAt: state.updatedAt,
  };
}

export function fromStateItem(item: RoundStateItem): RoundState {
  return {
    roundId: item.roundId,
    currentHole: item.currentHole,
    status: item.status,
    stateVersion: item.stateVersion,
    updatedAt: item.updatedAt,
  };
}
