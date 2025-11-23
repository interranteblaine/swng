/* eslint-disable @typescript-eslint/no-explicit-any */
import { marshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBRecord } from "aws-lambda";
import type { Player, Score, RoundState } from "@swng/domain";

export const NOW = "2024-01-01T00:00:00.000Z";

/**
 * Minimal helper to build a DynamoDB stream record with AttributeValue maps.
 */
export function ddbRecord(
  eventName: "INSERT" | "MODIFY" | "REMOVE",
  newImage?: unknown,
  oldImage?: unknown
): DynamoDBRecord {
  return {
    eventName,
    dynamodb: {
      NewImage: newImage ? (marshall(newImage as any) as any) : undefined,
      OldImage: oldImage ? (marshall(oldImage as any) as any) : undefined,
    } as any,
  } as any;
}

export function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    roundId: "r1",
    playerId: "p1",
    name: "Alice",
    color: "#000000",
    joinedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeScore(overrides: Partial<Score> = {}): Score {
  return {
    roundId: "r1",
    playerId: "p1",
    holeNumber: 1,
    strokes: 4,
    updatedBy: "p1",
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeState(overrides: Partial<RoundState> = {}): RoundState {
  return {
    roundId: "r1",
    currentHole: 1,
    status: "IN_PROGRESS",
    stateVersion: 1,
    updatedAt: NOW,
    ...overrides,
  };
}
