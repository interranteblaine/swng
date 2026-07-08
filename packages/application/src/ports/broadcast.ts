import type { RoundEvent, RoundId } from "@swng/domain";

// Delivery sugar (architecture.md §3: "the WebSocket is delivery sugar; HTTP catch-up is
// the correctness path") — a use case fires-and-forgets seq-stamped events at whoever's
// listening; nothing about round state depends on a publish landing.
export interface Broadcast {
  publish(roundId: RoundId, events: readonly RoundEvent[]): Promise<void>;
}
