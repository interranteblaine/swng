/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApiGatewayBroadcastPort } from "../index";
import type { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import type { ConnectionRepository } from "@swng/application";
import type { DomainEvent, RoundId } from "@swng/domain";

const NOW = "2025-01-01T00:00:00.000Z";

function makePlayerJoined(roundId: RoundId): DomainEvent {
  return {
    type: "PlayerJoined",
    roundId,
    occurredAt: NOW,
    player: {
      roundId,
      playerId: "pid-1",
      name: "Alice",
      color: "#000000",
      joinedAt: NOW,
      updatedAt: NOW,
    },
  };
}

function makePlayerUpdated(roundId: RoundId): DomainEvent {
  return {
    type: "PlayerUpdated",
    roundId,
    occurredAt: NOW,
    player: {
      roundId,
      playerId: "pid-1",
      name: "Alice2",
      color: "#111111",
      joinedAt: NOW,
      updatedAt: NOW,
    },
  };
}

function makeScoreChanged(roundId: RoundId): DomainEvent {
  return {
    type: "ScoreChanged",
    roundId,
    occurredAt: NOW,
    score: {
      roundId,
      playerId: "pid-1",
      holeNumber: 1,
      strokes: 3,
      updatedBy: "pid-1",
      updatedAt: NOW,
    },
  };
}

function makeRoundStateChanged(roundId: RoundId): DomainEvent {
  return {
    type: "RoundStateChanged",
    roundId,
    occurredAt: NOW,
    state: {
      roundId,
      status: "IN_PROGRESS",
      stateVersion: 1,
      updatedAt: NOW,
    },
  } as DomainEvent;
}

describe("ApiGatewayBroadcastPort notify()", () => {
  const roundId: RoundId = "rid-1";
  const conn1 = {
    roundId,
    connectionId: "c1",
    playerId: "pid-1",
    connectedAt: NOW,
  };
  const conn2 = {
    roundId,
    connectionId: "c2",
    playerId: "pid-2",
    connectedAt: NOW,
  };

  let sendMock: ReturnType<typeof vi.fn>;
  let client: ApiGatewayManagementApiClient;
  let listConnections: ReturnType<typeof vi.fn>;
  let removeConnection: ReturnType<typeof vi.fn>;
  let connectionRepo: ConnectionRepository;

  beforeEach(() => {
    sendMock = vi.fn(async () => ({}));
    client = { send: sendMock } as unknown as ApiGatewayManagementApiClient;

    listConnections = vi.fn(async () => [conn1, conn2]);
    removeConnection = vi.fn(async () => {});
    connectionRepo = {
      addConnection: vi.fn(),
      removeConnection,
      listConnections,
    } as unknown as ConnectionRepository;
  });

  it("broadcasts to all active connections for a DomainEvent", async () => {
    const broadcast = createApiGatewayBroadcastPort({
      client,
      connectionRepo,
    });

    await broadcast.notify(roundId, makePlayerJoined(roundId));

    expect(listConnections).toHaveBeenCalledWith(roundId);
    expect(sendMock).toHaveBeenCalledTimes(2);

    const ids = new Set(
      sendMock.mock.calls.map(([cmd]) => (cmd as any).input?.ConnectionId)
    );
    expect(ids).toEqual(new Set(["c1", "c2"]));
  });

  it("removes stale connections when API returns Gone", async () => {
    sendMock = vi.fn(async (cmd: unknown) => {
      const id = (cmd as any).input?.ConnectionId;
      if (id === "c1") {
        throw { name: "GoneException", $metadata: { httpStatusCode: 410 } };
      }
      return {};
    });
    client = { send: sendMock } as unknown as ApiGatewayManagementApiClient;

    connectionRepo = {
      addConnection: vi.fn(),
      removeConnection,
      listConnections,
    } as unknown as ConnectionRepository;

    const broadcast = createApiGatewayBroadcastPort({
      client,
      connectionRepo,
    });

    await broadcast.notify(roundId, makePlayerUpdated(roundId));

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(removeConnection).toHaveBeenCalledWith(roundId, "c1");
  });

  it("no-ops when there are no active connections", async () => {
    listConnections.mockResolvedValue([]);

    const broadcast = createApiGatewayBroadcastPort({
      client,
      connectionRepo,
    });

    await broadcast.notify(roundId, makeScoreChanged(roundId));
    await broadcast.notify(roundId, makeRoundStateChanged(roundId));

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("retries once when initial list is empty, then broadcasts", async () => {
    // First call: no connections; second call: two connections
    listConnections.mockResolvedValueOnce([]);
    listConnections.mockResolvedValueOnce([conn1, conn2]);

    const broadcast = createApiGatewayBroadcastPort({
      client,
      connectionRepo,
    });

    const evt = makePlayerJoined(roundId);
    const before = Date.now();
    await broadcast.notify(roundId, evt);
    const elapsed = Date.now() - before;

    // Should have attempted to send to both after retry
    expect(sendMock).toHaveBeenCalledTimes(2);
    const ids = new Set(
      sendMock.mock.calls.map(([cmd]) => (cmd as any).input?.ConnectionId)
    );
    expect(ids).toEqual(new Set(["c1", "c2"]));

    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  it("gives up after retry when still empty", async () => {
    listConnections.mockResolvedValueOnce([]);
    listConnections.mockResolvedValueOnce([]);

    const broadcast = createApiGatewayBroadcastPort({
      client,
      connectionRepo,
    });

    await broadcast.notify(roundId, makeScoreChanged(roundId));
    expect(sendMock).not.toHaveBeenCalled();
  });
});
