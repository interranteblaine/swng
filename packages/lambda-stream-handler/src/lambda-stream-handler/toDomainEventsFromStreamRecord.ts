import type {
  DomainEvent,
  PlayerJoinedEvent,
  PlayerUpdatedEvent,
  ScoreChangedEvent,
  RoundStateChangedEvent,
  Player,
  Score,
  RoundState,
  RoundId,
} from "@swng/domain";
import type { DynamoDBRecord } from "aws-lambda";
import { unmarshall } from "@aws-sdk/util-dynamodb";

import type {
  PlayerItem,
  ScoreItem,
  RoundStateItem,
} from "@swng/adapters-dynamodb";
import {
  fromPlayerItem,
  fromScoreItem,
  fromStateItem,
  PLAYER_SK_PREFIX,
  SCORE_SK_PREFIX,
  STATE_SK,
} from "@swng/adapters-dynamodb";

/**
 * Map a single DynamoDB stream record into zero or more DomainEvent objects.
 *
 * Emits:
 * - PlayerJoined       on INSERT of PLAYER item
 * - PlayerUpdated      on MODIFY of PLAYER item
 * - ScoreChanged       on INSERT/MODIFY of SCORE item
 * - RoundStateChanged  on MODIFY of STATE item, but only if material fields changed
 *
 * Ignores:
 * - REMOVE events
 * - CONFIG or unknown shapes
 */
export function toDomainEventsFromStreamRecord(
  record: DynamoDBRecord
): DomainEvent[] {
  const events: DomainEvent[] = [];

  const dd = record.dynamodb;
  if (!dd || !dd.NewImage) {
    // No new image → nothing to emit (includes REMOVE)
    return events;
  }

  // Convert AttributeValue map → plain JS object (matching our *Item shapes)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const newRaw = unmarshall(dd.NewImage as any) as
    | PlayerItem
    | ScoreItem
    | RoundStateItem
    | { SK?: string; roundId?: string };

  const sk = newRaw.SK;
  const roundId = newRaw.roundId as RoundId | undefined;

  if (!sk || !roundId) {
    return events;
  }

  const eventName = record.eventName;

  // PLAYER ITEMS
  if (sk.startsWith(PLAYER_SK_PREFIX)) {
    const newItem = newRaw as PlayerItem;
    const newPlayer: Player = fromPlayerItem(newItem);

    if (eventName === "INSERT") {
      const evt: PlayerJoinedEvent = {
        type: "PlayerJoined",
        roundId,
        occurredAt: newPlayer.joinedAt,
        player: newPlayer,
      };
      events.push(evt);
      return events;
    }

    if (eventName === "MODIFY") {
      const evt: PlayerUpdatedEvent = {
        type: "PlayerUpdated",
        roundId,
        occurredAt: newPlayer.updatedAt,
        player: newPlayer,
      };
      events.push(evt);
      return events;
    }

    return events;
  }

  // SCORE ITEMS
  if (sk.startsWith(SCORE_SK_PREFIX)) {
    const newItem = newRaw as ScoreItem;
    const newScore: Score = fromScoreItem(newItem);

    if (eventName === "INSERT" || eventName === "MODIFY") {
      const evt: ScoreChangedEvent = {
        type: "ScoreChanged",
        roundId,
        occurredAt: newScore.updatedAt,
        score: newScore,
      };
      events.push(evt);
      return events;
    }

    return events;
  }

  // ROUND STATE
  if (sk === STATE_SK) {
    // Only emit on actual changes; we consider MODIFY with OldImage
    if (eventName !== "MODIFY" || !dd.OldImage) {
      return events;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oldRaw = unmarshall(dd.OldImage as any) as RoundStateItem;
    const newItem = newRaw as RoundStateItem;

    const oldState: RoundState = fromStateItem(oldRaw);
    const newState: RoundState = fromStateItem(newItem);

    const changed =
      oldState.currentHole !== newState.currentHole ||
      oldState.status !== newState.status ||
      oldState.stateVersion !== newState.stateVersion;

    if (!changed) {
      return events;
    }

    const evt: RoundStateChangedEvent = {
      type: "RoundStateChanged",
      roundId,
      occurredAt: newState.updatedAt,
      state: newState,
    };

    events.push(evt);
    return events;
  }

  // CONFIG or anything else → no events
  return events;
}
