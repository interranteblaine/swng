import type { RoundId, PlayerId } from "@swng/domain";

/**
 * Table design:
 *
 * PK: "ROUND#<roundId>" / "SESSION#<sessionId>"
 * SK:
 *   - "CONFIG"
 *   - "STATE"
 *   - "PLAYER#<playerId>"
 *   - "SCORE#PLAYER#<playerId>#HOLE#<holeNumber>"
 *   - "CONNECTION#<connectionId>"
 *
 * GSI1PK for round CONFIG: "CODE#<accessCode>"
 * GSI1SK: "ROUND#<roundId>"
 */

export const PK = "PK";
export const SK = "SK";
export const GSI1_NAME = "GSI1";
export const CONFIG_SK = "CONFIG";
export const STATE_SK = "STATE";
export const SESSION_SK = "METADATA";
export const PLAYER_SK_PREFIX = "PLAYER#";
export const SCORE_SK_PREFIX = "SCORE#PLAYER#";
export const CONNECTION_SK_PREFIX = "CONNECTION#";

export function roundPk(roundId: RoundId): string {
  return `ROUND#${roundId}`;
}

export function sessionPk(sessionId: string): string {
  return `SESSION#${sessionId}`;
}

export function codeGsiPk(accessCode: string): string {
  return `CODE#${accessCode}`;
}

export function playerSk(playerId: PlayerId): string {
  return `${PLAYER_SK_PREFIX}${playerId}`;
}

export function scoreSk(playerId: PlayerId, holeNumber: number): string {
  return `${SCORE_SK_PREFIX}${playerId}#HOLE#${holeNumber}`;
}

export function connectionSk(connectionId: string): string {
  return `${CONNECTION_SK_PREFIX}${connectionId}`;
}
