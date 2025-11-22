/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApiGatewayBroadcastPort } from "../index";
import type { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import type { ConnectionRepository } from "@swng/application";
import type { Player, Score, RoundState, RoundId } from "@swng/domain";

const NOW = "2025-01-01T00:00:00.000Z";

function makePlayer(roundId: RoundId): Player {
  return {
    roundId,
    playerId: "pid-1",
    name: "Alice",
    color: "#000000",
    joinedAt: NOW,
    updatedAt: NOW,
  };
}

function makeScore(roundId: RoundId): Score {
  return {
    roundId,
    playerId: "pid-1",
    holeNumber: 1,
    strokes: 3,
    updatedBy: "pid-1",
    updatedAt: NOW,
  };
}

function makeState(roundId: RoundId): RoundState {
  return {
    roundId,
    currentHole: 1,
    status: "IN_PROGRESS",
    stateVersion: 1,
    updatedAt: NOW,
  };
}

describe("ApiGatewayBroadcastPort behavior", () => {
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

  it("broadcasts to all active connections for PlayerJoined", async () => {
    const broadcast = createApiGatewayBroadcastPort({
      endpoint: "https://example.com/dev",
      region: "us-east-1",
      client,
      connectionRepo,
    });

    await broadcast.broadcastPlayerJoined(roundId, makePlayer(roundId));

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
      endpoint: "https://example.com/dev",
      region: "us-east-1",
      client,
      connectionRepo,
    });

    await broadcast.broadcastPlayerUpdated(roundId, makePlayer(roundId));

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(removeConnection).toHaveBeenCalledWith(roundId, "c1");
  });

  it("no-ops when there are no active connections", async () => {
    listConnections.mockResolvedValue([]);

    const broadcast = createApiGatewayBroadcastPort({
      endpoint: "https://example.com/dev",
      region: "us-east-1",
      client,
      connectionRepo,
    });

    await broadcast.broadcastScoreChanged(roundId, makeScore(roundId));
    await broadcast.broadcastRoundStateChanged(roundId, makeState(roundId));

    expect(sendMock).not.toHaveBeenCalled();
  });
});
