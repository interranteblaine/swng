import { describe, test, expect, vi, beforeEach } from "vitest";
import { handleDomainEvent } from "../application/events";
import type { BroadcastPort } from "../application/types";
import type {
  PlayerJoinedEvent,
  PlayerUpdatedEvent,
  ScoreChangedEvent,
  RoundStateChangedEvent,
  DomainEvent,
  Player,
  Score,
  RoundState,
} from "@swng/domain";

describe("handleDomainEvent", () => {
  let broadcast: BroadcastPort;
  const occurredAt = "2025-11-16T00:00:00.000Z";

  beforeEach(() => {
    broadcast = {
      broadcastPlayerJoined: vi.fn(),
      broadcastPlayerUpdated: vi.fn(),
      broadcastScoreChanged: vi.fn(),
      broadcastRoundStateChanged: vi.fn(),
    };
  });

  test("PlayerJoined triggers broadcastPlayerJoined", async () => {
    const player: Player = {
      roundId: "rid1",
      playerId: "pid1",
      name: "Alice",
      color: "#fff",
      joinedAt: occurredAt,
      updatedAt: occurredAt,
    };
    const event: PlayerJoinedEvent = {
      type: "PlayerJoined",
      roundId: "rid1",
      occurredAt,
      player,
    };
    await handleDomainEvent(event, broadcast);
    expect(broadcast.broadcastPlayerJoined).toHaveBeenCalledWith(
      "rid1",
      player
    );
  });

  test("PlayerUpdated triggers broadcastPlayerUpdated", async () => {
    const player: Player = {
      roundId: "rid2",
      playerId: "pid2",
      name: "Bob",
      color: "#000",
      joinedAt: occurredAt,
      updatedAt: occurredAt,
    };
    const event: PlayerUpdatedEvent = {
      type: "PlayerUpdated",
      roundId: "rid2",
      occurredAt,
      player,
    };
    await handleDomainEvent(event, broadcast);
    expect(broadcast.broadcastPlayerUpdated).toHaveBeenCalledWith(
      "rid2",
      player
    );
  });

  test("ScoreChanged triggers broadcastScoreChanged", async () => {
    const score: Score = {
      roundId: "rid3",
      playerId: "pid3",
      holeNumber: 1,
      strokes: 4,
      updatedBy: "pid3",
      updatedAt: occurredAt,
    };
    const event: ScoreChangedEvent = {
      type: "ScoreChanged",
      roundId: "rid3",
      occurredAt,
      score,
    };
    await handleDomainEvent(event, broadcast);
    expect(broadcast.broadcastScoreChanged).toHaveBeenCalledWith("rid3", score);
  });

  test("RoundStateChanged triggers broadcastRoundStateChanged", async () => {
    const state: RoundState = {
      roundId: "rid4",
      currentHole: 2,
      stateVersion: 5,
      status: "COMPLETED",
      updatedAt: occurredAt,
    };
    const event: RoundStateChangedEvent = {
      type: "RoundStateChanged",
      roundId: "rid4",
      occurredAt,
      state,
    };
    await handleDomainEvent(event, broadcast);
    expect(broadcast.broadcastRoundStateChanged).toHaveBeenCalledWith(
      "rid4",
      state
    );
  });

  test("unknown type does not trigger any broadcast", async () => {
    const event = {
      type: "RandomEvent",
      roundId: "ridX",
      occurredAt,
    } as unknown as DomainEvent;
    await handleDomainEvent(event, broadcast);
    expect(broadcast.broadcastPlayerJoined).not.toHaveBeenCalled();
    expect(broadcast.broadcastPlayerUpdated).not.toHaveBeenCalled();
    expect(broadcast.broadcastScoreChanged).not.toHaveBeenCalled();
    expect(broadcast.broadcastRoundStateChanged).not.toHaveBeenCalled();
  });
});
