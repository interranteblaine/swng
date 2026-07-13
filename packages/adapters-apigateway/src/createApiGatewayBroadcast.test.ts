import { describe, expect, it, vi } from "vitest";
import type { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import { GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import type { RoundEvent, RoundId } from "@swng/domain";
import { deviceId, golferId, opId, roundId } from "@swng/domain";
import type { ConnectionRegistry, Logger } from "@swng/application";
import { createApiGatewayBroadcast } from "./createApiGatewayBroadcast.js";

// Not part of application's exported fakes (testing/fakes.ts has no ConnectionRegistry —
// it's WS delivery infrastructure, consumed only by ws entries + this adapter, per its own
// port doc comment) — a small local fake is exactly what M3 Task 4's brief calls for here.
const createInMemoryConnectionRegistry = (): ConnectionRegistry => {
  const byRound = new Map<RoundId, Set<string>>();
  return {
    register: async (connectionId, forRoundId) => {
      const existing = byRound.get(forRoundId) ?? new Set<string>();
      existing.add(connectionId);
      byRound.set(forRoundId, existing);
    },
    deregister: async (connectionId) => {
      for (const connectionIds of byRound.values()) connectionIds.delete(connectionId);
    },
    listByRound: async (forRoundId) => [...(byRound.get(forRoundId) ?? [])].sort(),
  };
};

const sampleEvent: RoundEvent = {
  kind: "round-started",
  opId: opId("op-1"),
  hlc: { wallMs: 1, counter: 0, deviceId: deviceId("server") },
  authorId: golferId("ann"),
  seq: 1,
};

describe("createApiGatewayBroadcast", () => {
  it("publishes the wsEnvelope to every connection registered for the round", async () => {
    const connections = createInMemoryConnectionRegistry();
    const rid = roundId("round-1");
    await connections.register("conn-a", rid);
    await connections.register("conn-b", rid);

    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as ApiGatewayManagementApiClient;
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const broadcast = createApiGatewayBroadcast({ client, connections, logger });

    await broadcast.publish(rid, [sampleEvent]);

    expect(send).toHaveBeenCalledTimes(2);
    const commands = send.mock.calls.map(([command]) => command as PostToConnectionCommand);
    for (const command of commands) {
      expect(command).toBeInstanceOf(PostToConnectionCommand);
      expect(JSON.parse(command.input.Data as string)).toEqual({ type: "events", roundId: rid, events: [sampleEvent] });
    }
    expect(commands.map((command) => command.input.ConnectionId).sort()).toEqual(["conn-a", "conn-b"]);
  });

  it("does nothing when nobody is connected to the round", async () => {
    const connections = createInMemoryConnectionRegistry();
    const send = vi.fn();
    const client = { send } as unknown as ApiGatewayManagementApiClient;
    const broadcast = createApiGatewayBroadcast({ client, connections, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

    await broadcast.publish(roundId("round-empty"), [sampleEvent]);

    expect(send).not.toHaveBeenCalled();
  });

  it("deregisters a connection whose PostToConnection throws GoneException, and never rejects", async () => {
    const connections = createInMemoryConnectionRegistry();
    const rid = roundId("round-1");
    await connections.register("conn-gone", rid);
    await connections.register("conn-alive", rid);

    const send = vi.fn().mockImplementation((command: PostToConnectionCommand) =>
      command.input.ConnectionId === "conn-gone"
        ? Promise.reject(new GoneException({ message: "connection is gone", $metadata: {} }))
        : Promise.resolve({}),
    );
    const client = { send } as unknown as ApiGatewayManagementApiClient;
    const broadcast = createApiGatewayBroadcast({ client, connections, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

    await expect(broadcast.publish(rid, [sampleEvent])).resolves.toBeUndefined();

    expect(await connections.listByRound(rid)).toEqual(["conn-alive"]);
  });

  it("logs but never rejects when every connection throws a non-Gone error", async () => {
    const connections = createInMemoryConnectionRegistry();
    const rid = roundId("round-1");
    await connections.register("conn-a", rid);

    const send = vi.fn().mockRejectedValue(new Error("network blip"));
    const client = { send } as unknown as ApiGatewayManagementApiClient;
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const broadcast = createApiGatewayBroadcast({ client, connections, logger });

    await expect(broadcast.publish(rid, [sampleEvent])).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    // A generic failure isn't a signal the connection is dead — it stays registered.
    expect(await connections.listByRound(rid)).toEqual(["conn-a"]);
  });

  it("logs but never rejects when connections.listByRound throws, and never attempts a send", async () => {
    const rid = roundId("round-1");
    const connections: ConnectionRegistry = {
      register: vi.fn(),
      deregister: vi.fn(),
      listByRound: vi.fn().mockRejectedValue(new Error("registry unavailable")),
    };
    const send = vi.fn();
    const client = { send } as unknown as ApiGatewayManagementApiClient;
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const broadcast = createApiGatewayBroadcast({ client, connections, logger });

    await expect(broadcast.publish(rid, [sampleEvent])).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("logs but never rejects when connections.deregister throws during Gone-cleanup", async () => {
    const connections = createInMemoryConnectionRegistry();
    const rid = roundId("round-1");
    await connections.register("conn-gone", rid);

    const send = vi.fn().mockRejectedValue(new GoneException({ message: "connection is gone", $metadata: {} }));
    const client = { send } as unknown as ApiGatewayManagementApiClient;
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deregisterSpy = vi.spyOn(connections, "deregister").mockRejectedValue(new Error("registry unavailable"));
    const broadcast = createApiGatewayBroadcast({ client, connections, logger });

    await expect(broadcast.publish(rid, [sampleEvent])).resolves.toBeUndefined();

    expect(deregisterSpy).toHaveBeenCalledWith("conn-gone");
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
