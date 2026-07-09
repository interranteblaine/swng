import { TransportError } from "@swng/client";
import type { RoundTransport } from "@swng/client";
import type { RoundEvent } from "@swng/domain";

// A scripted RoundTransport double — an in-memory server log with push/pull/openSocket wired
// the same shape as @swng/client's real HTTP+WS transport, but synchronous and
// script-controlled (an `offline` flag instead of real network failures). Shared because
// every apps/web test that needs a LIVE (non-idle) useRoundSession — via
// createUseRoundSession's own DI seam — needs one of these, and this was already the third
// copy of this exact pattern in the repo (packages/client/src/session.test.ts and
// convergence.properties.test.ts hold their own) before this extraction. apps/web can't
// import those directly — the layer rule (eslint.config.mjs) only allows @swng/client's
// public surface, not its test internals — so this is apps/web's own single copy, shared
// across its test files instead of re-duplicated per spec file.
export interface ScriptedTransport extends RoundTransport {
  readonly log: readonly RoundEvent[];
  offline: boolean;
  socketCloseCalls: number;
  socketOpenCalls: number; // proves connect()'s own idempotency (session.ts: "if (connectedFlag) return")
}

export const createScriptedTransport = (seed: readonly RoundEvent[]): ScriptedTransport => {
  const log: RoundEvent[] = [...seed];
  let nextSeq = log.length + 1;
  let socketListener: { onEvents: (events: readonly RoundEvent[]) => void; onClose: () => void } | undefined;

  const transport: ScriptedTransport = {
    log,
    offline: false,
    socketCloseCalls: 0,
    socketOpenCalls: 0,
    push: async (event) => {
      if (transport.offline) throw new TransportError("network");
      const existing = log.find((logged) => logged.opId === event.opId);
      if (existing) return { seq: existing.seq, duplicate: true };
      const stamped: RoundEvent = { ...event, seq: nextSeq };
      nextSeq += 1;
      log.push(stamped);
      return { seq: stamped.seq, duplicate: false };
    },
    pull: async (sinceSeq) => {
      if (transport.offline) throw new TransportError("network");
      const events = log.filter((event) => (event.seq ?? 0) > sinceSeq);
      const maxSeq = events.reduce((max, event) => Math.max(max, event.seq ?? 0), sinceSeq);
      return { events, nextSeq: maxSeq };
    },
    openSocket: (onEvents, onClose, onOpen) => {
      transport.socketOpenCalls += 1;
      socketListener = { onEvents, onClose };
      onOpen?.();
      return () => {
        transport.socketCloseCalls += 1;
        if (socketListener?.onEvents === onEvents) socketListener = undefined;
      };
    },
  };
  return transport;
};

// Stamps sequential `seq`s onto a hand-authored event list (index+1) — factored out so every
// scenario-specific server-log builder (one per spec file; these differ in participants/games,
// not in transport plumbing) doesn't hand-roll its own `.map((event, index) => ({ ...event,
// seq: index + 1 }))`. Takes RoundEvent, not Omit<RoundEvent, "seq"> — seq is already optional
// on RoundEventBase, and Omit over a discriminated union collapses it to its common keys
// (state.ts's withoutSeq carries the same note), which would reject every event-specific field
// (roundId, participant, config, ...) this helper actually needs to accept.
export const stampSeq = (events: readonly RoundEvent[]): RoundEvent[] => events.map((event, index) => ({ ...event, seq: index + 1 }));
