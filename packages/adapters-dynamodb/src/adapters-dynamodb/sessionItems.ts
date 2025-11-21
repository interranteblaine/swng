import type { IsoDateTime, RoundId, PlayerId } from "@swng/domain";
import { SESSION_SK, sessionPk } from "./keys";

export interface SessionItem {
  PK: string;
  SK: typeof SESSION_SK;
  sessionId: string;
  roundId: RoundId;
  playerId: PlayerId;
  expiresAt: IsoDateTime;
  ttl: number;
}

export function toSessionItem(session: {
  sessionId: string;
  roundId: RoundId;
  playerId: PlayerId;
  expiresAt: IsoDateTime;
}): SessionItem {
  return {
    PK: sessionPk(session.sessionId),
    SK: SESSION_SK,
    sessionId: session.sessionId,
    roundId: session.roundId,
    playerId: session.playerId,
    expiresAt: session.expiresAt,
    ttl: Math.floor(new Date(session.expiresAt).getTime() / 1000),
  };
}

export function fromSessionItem(item: SessionItem) {
  return {
    sessionId: item.sessionId,
    roundId: item.roundId,
    playerId: item.playerId,
    expiresAt: item.expiresAt,
  };
}
