import type { RoundEvent, RoundId } from "@swng/domain";

// What a session needs to survive a restart: the still-unconfirmed outbox, the pull
// cursor, and the opId counter. Confirmed events are deliberately NOT part of this shape
// (derive, don't store) — a restarted session re-pulls them from the server instead.
export interface PersistedSync {
  readonly pending: readonly RoundEvent[];
  readonly lastSeq: number;
  // Highest opId counter minted on this device — persisted so a restarted session can
  // NEVER re-mint an opId it already used (a reused opId would make the server silently
  // drop the new event as a duplicate of the old one).
  readonly opCounter: number;
}

export interface OutboxStore {
  load(roundId: RoundId): Promise<PersistedSync | undefined>;
  save(roundId: RoundId, sync: PersistedSync): Promise<void>;
}

export const createMemoryOutboxStore = (): OutboxStore => {
  const byRound = new Map<RoundId, PersistedSync>();
  return {
    load: async (roundId) => byRound.get(roundId),
    save: async (roundId, sync) => {
      byRound.set(roundId, sync);
    },
  };
};
