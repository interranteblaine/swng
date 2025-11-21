import type { Player, PlayerId, RoundId, IsoDateTime } from "@swng/domain";
import { playerSk, roundPk } from "./keys";

export interface PlayerItem {
  PK: string;
  SK: string;
  roundId: RoundId;
  playerId: PlayerId;
  name: string;
  color: string;
  joinedAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export function toPlayerItem(player: Player): PlayerItem {
  return {
    PK: roundPk(player.roundId),
    SK: playerSk(player.playerId),
    roundId: player.roundId,
    playerId: player.playerId,
    name: player.name,
    color: player.color,
    joinedAt: player.joinedAt,
    updatedAt: player.updatedAt,
  };
}

export function fromPlayerItem(item: PlayerItem): Player {
  return {
    roundId: item.roundId,
    playerId: item.playerId,
    name: item.name,
    color: item.color,
    joinedAt: item.joinedAt,
    updatedAt: item.updatedAt,
  };
}
