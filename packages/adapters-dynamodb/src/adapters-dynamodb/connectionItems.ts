import type { IsoDateTime, PlayerId, RoundId } from "@swng/domain";
import type { Connection } from "@swng/application";
import { roundPk, connectionSk } from "./keys";

export interface ConnectionItem {
  PK: string;
  SK: string;
  roundId: RoundId;
  connectionId: string;
  playerId: PlayerId;
  connectedAt: IsoDateTime;
  ttl?: number;
}

export function toConnectionItem(
  connection: Connection,
  ttlSeconds?: number
): ConnectionItem {
  return {
    PK: roundPk(connection.roundId),
    SK: connectionSk(connection.connectionId),
    roundId: connection.roundId,
    connectionId: connection.connectionId,
    playerId: connection.playerId,
    connectedAt: connection.connectedAt,
    ...(ttlSeconds ? { ttl: ttlSeconds } : {}),
  };
}

export function fromConnectionItem(item: ConnectionItem): Connection {
  return {
    roundId: item.roundId,
    connectionId: item.connectionId,
    playerId: item.playerId,
    connectedAt: item.connectedAt,
  };
}
