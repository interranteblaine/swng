import type { RoundEvent, RoundId } from "@swng/domain";

// An op the server refused PERMANENTLY (a real 4xx — a finalized round, a score for someone
// who never joined), as opposed to a transient failure that just stays queued. It is kept,
// never deleted: an unpushed event exists nowhere but this device, so dropping it is the only
// unrecoverable thing this SDK can do. The archive it failed to reach is re-derivable; this
// is not.
export interface RejectedOp {
  readonly event: RoundEvent;
  readonly code: string;
}

// What a session needs to survive a restart: the still-unconfirmed outbox, the ops that were
// refused, the pull cursor, and the opId counter. Confirmed events are deliberately NOT part
// of this shape (derive, don't store) — a restarted session re-pulls them from the server
// instead.
export interface PersistedSync {
  readonly pending: readonly RoundEvent[];
  readonly lastSeq: number;
  // Highest opId counter minted on this device — persisted so a restarted session can
  // NEVER re-mint an opId it already used (a reused opId would make the server silently
  // drop the new event as a duplicate of the old one).
  readonly opCounter: number;
  // Required on the type, defaulted on read: a record written before this field existed loads
  // without it, and `persisted?.rejected ?? []` is what tolerates that — the same defence the
  // equally-required `pending` already gets. No migration, no store version bump.
  readonly rejected: readonly RejectedOp[];
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
