/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBRecord } from "aws-lambda";
import type { Player, Score, RoundState } from "@swng/domain";
import {
  toPlayerItem,
  toScoreItem,
  toStateItem,
} from "@swng/adapters-dynamodb";
import { toDomainEventsFromStreamRecord } from "../lambda-stream-handler/toDomainEventsFromStreamRecord";

const NOW = "2024-01-01T00:00:00.000Z";

function makeRecord(
  eventName: "INSERT" | "MODIFY" | "REMOVE",
  opts?: {
    newImage?: unknown;
    oldImage?: unknown;
  }
): DynamoDBRecord {
  const NewImage = opts?.newImage
    ? (marshall(opts.newImage as any) as any)
    : undefined;
  const OldImage = opts?.oldImage
    ? (marshall(opts.oldImage as any) as any)
    : undefined;

  return {
    eventName,
    dynamodb: {
      NewImage,
      OldImage,
    } as any,
  } as any;
}

describe("toDomainEventsFromStreamRecord", () => {
  const roundId = "r1";
  const playerId = "p1";

  it("emits PlayerJoined for player INSERT", () => {
    const player: Player = {
      roundId,
      playerId,
      name: "Alice",
      color: "#000000",
      joinedAt: NOW,
      updatedAt: NOW,
    };

    const rec = makeRecord("INSERT", { newImage: toPlayerItem(player) });
    const events = toDomainEventsFromStreamRecord(rec);

    expect(events).toEqual([
      {
        type: "PlayerJoined",
        roundId,
        occurredAt: player.joinedAt,
        player,
      },
    ]);
  });

  it("emits PlayerUpdated for player MODIFY", () => {
    const before: Player = {
      roundId,
      playerId,
      name: "Alice",
      color: "#000000",
      joinedAt: NOW,
      updatedAt: NOW,
    };
    const after: Player = {
      ...before,
      name: "Alice Smith",
      updatedAt: NOW,
    };

    const rec = makeRecord("MODIFY", {
      newImage: toPlayerItem(after),
      oldImage: toPlayerItem(before),
    });
    const events = toDomainEventsFromStreamRecord(rec);

    expect(events).toEqual([
      {
        type: "PlayerUpdated",
        roundId,
        occurredAt: after.updatedAt,
        player: after,
      },
    ]);
  });

  it("emits ScoreChanged for score INSERT", () => {
    const score: Score = {
      roundId,
      playerId,
      holeNumber: 1,
      strokes: 4,
      updatedBy: playerId,
      updatedAt: NOW,
    };

    const rec = makeRecord("INSERT", { newImage: toScoreItem(score) });
    const events = toDomainEventsFromStreamRecord(rec);

    expect(events).toEqual([
      {
        type: "ScoreChanged",
        roundId,
        occurredAt: score.updatedAt,
        score,
      },
    ]);
  });

  it("emits ScoreChanged for score MODIFY", () => {
    const before: Score = {
      roundId,
      playerId,
      holeNumber: 1,
      strokes: 4,
      updatedBy: playerId,
      updatedAt: NOW,
    };
    const after: Score = {
      ...before,
      strokes: 5,
      updatedAt: NOW,
    };

    const rec = makeRecord("MODIFY", {
      newImage: toScoreItem(after),
      oldImage: toScoreItem(before),
    });
    const events = toDomainEventsFromStreamRecord(rec);

    expect(events).toEqual([
      {
        type: "ScoreChanged",
        roundId,
        occurredAt: after.updatedAt,
        score: after,
      },
    ]);
  });

  it("emits RoundStateChanged for state MODIFY only when fields changed", () => {
    const before: RoundState = {
      roundId,
      currentHole: 1,
      status: "IN_PROGRESS",
      stateVersion: 1,
      updatedAt: NOW,
    };
    const changed: RoundState = {
      ...before,
      currentHole: 2,
      stateVersion: 2,
      updatedAt: NOW,
    };

    // changed -> emit
    const changedRec = makeRecord("MODIFY", {
      newImage: toStateItem(changed),
      oldImage: toStateItem(before),
    });
    const changedEvents = toDomainEventsFromStreamRecord(changedRec);
    expect(changedEvents).toEqual([
      {
        type: "RoundStateChanged",
        roundId,
        occurredAt: changed.updatedAt,
        state: changed,
      },
    ]);

    // unchanged -> no emit
    const unchangedRec = makeRecord("MODIFY", {
      newImage: toStateItem(before),
      oldImage: toStateItem(before),
    });
    const unchangedEvents = toDomainEventsFromStreamRecord(unchangedRec);
    expect(unchangedEvents).toEqual([]);
  });

  it("ignores REMOVE and records without NewImage", () => {
    const rec = makeRecord("REMOVE");
    const events = toDomainEventsFromStreamRecord(rec);
    expect(events).toEqual([]);
  });
});
