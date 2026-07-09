import { TransportError } from "../transport.js";
import type { RoundTransport } from "../transport.js";
import type { DeviceId, RoundEvent } from "@swng/domain";

// Test-only in-memory server double for the M4 convergence simulation
// (packages/client/src/convergence.properties.test.ts). Built from DOMAIN primitives ONLY —
// packages/client's layer law (eslint.config.mjs) forbids importing @swng/application, so
// this is deliberately NOT the real application/adapters-dynamodb journal. It mirrors that
// journal's CONTRACT instead — the same one
// packages/adapters-dynamodb/src/contract/journal.contract.test.ts pins against a real
// DynamoDB Local: append dedupes by opId (a re-sent opId is a no-op that returns
// `duplicate: true` rather than appending a second copy or erroring), seq is assigned
// contiguously from 1 in append order, and read(sinceSeq) is exactly "events with
// seq > sinceSeq". The "notify every online socket" fan-out mirrors
// createApiGatewayBroadcast's behavior (packages/adapters-apigateway): there is no
// "exclude the author's own connection" special case there either —
// application/src/rounds/recordScore.ts always calls broadcast.publish for every appended
// event, so a device's own push can legitimately echo back over its own socket (harmless:
// session.ts's ingest() dedupes by opId).
export interface SimServer {
  transportFor(deviceId: DeviceId): RoundTransport & { setOnline(online: boolean): void };
  log(): readonly RoundEvent[]; // seq-stamped, append order
  seed(events: readonly RoundEvent[]): void; // creation/join/game-added scaffolding
}

interface SocketListener {
  readonly onEvents: (events: readonly RoundEvent[]) => void;
  readonly onClose: () => void;
}

// Per-device channel: online/offline flag plus (at most) one registered socket listener,
// mirroring one device having one live WebSocket connection at a time in the real system.
interface Channel {
  online: boolean;
  socket?: SocketListener;
}

export const createSimServer = (): SimServer => {
  const log: RoundEvent[] = [];
  let nextSeq = 1;
  const channels = new Map<DeviceId, Channel>();

  const channelFor = (id: DeviceId): Channel => {
    let channel = channels.get(id);
    if (!channel) {
      channel = { online: true };
      channels.set(id, channel);
    }
    return channel;
  };

  // Fan-out to every online, connected channel — see the module comment above for why the
  // author's own channel isn't excluded.
  const broadcast = (events: readonly RoundEvent[]): void => {
    if (events.length === 0) return;
    for (const channel of channels.values()) {
      if (channel.online && channel.socket) channel.socket.onEvents(events);
    }
  };

  const append = (event: RoundEvent): { seq: number; duplicate: boolean } => {
    const existing = log.find((logged) => logged.opId === event.opId);
    if (existing) return { seq: existing.seq ?? 0, duplicate: true };
    const stamped: RoundEvent = { ...event, seq: nextSeq };
    nextSeq += 1;
    log.push(stamped);
    broadcast([stamped]);
    return { seq: stamped.seq ?? 0, duplicate: false };
  };

  return {
    transportFor: (deviceIdValue: DeviceId): RoundTransport & { setOnline(online: boolean): void } => {
      const channel = channelFor(deviceIdValue);

      return {
        push: async (event: RoundEvent) => {
          if (!channel.online) throw new TransportError("network");
          return append(event);
        },

        pull: async (sinceSeq: number) => {
          if (!channel.online) throw new TransportError("network");
          const events = log.filter((event) => (event.seq ?? 0) > sinceSeq);
          const nextCursor = events.reduce((max, event) => Math.max(max, event.seq ?? 0), sinceSeq);
          return { events, nextSeq: nextCursor };
        },

        openSocket: (onEvents: (events: readonly RoundEvent[]) => void, onClose: () => void, onOpen?: () => void): (() => void) => {
          channel.socket = { onEvents, onClose };
          onOpen?.(); // this in-memory channel "opens" synchronously, right after registering
          return () => {
            if (channel.socket?.onEvents === onEvents) channel.socket = undefined;
          };
        },

        setOnline: (online: boolean): void => {
          const wasOnline = channel.online;
          channel.online = online;
          // Going offline drops any live socket and fires its onClose, exactly once, same
          // as a real dropped connection. Going online does NOT reopen a socket — the
          // brief's contract is explicit that reconnection is lazy, via the session calling
          // connect() again on its own.
          if (!online && wasOnline && channel.socket) {
            const socket = channel.socket;
            channel.socket = undefined;
            socket.onClose();
          }
        },
      };
    },

    log: () => log,

    seed: (events: readonly RoundEvent[]): void => {
      for (const event of events) {
        log.push({ ...event, seq: nextSeq });
        nextSeq += 1;
      }
    },
  };
};
