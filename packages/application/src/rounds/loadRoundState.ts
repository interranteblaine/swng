import type { RoundEvent, RoundId, RoundState } from "@swng/domain";
import { reduceRound } from "@swng/domain";
import { ApplicationError } from "../errors.js";
import type { EventJournal } from "../ports/eventJournal.js";

// Every use case that needs the round's current state starts here: an empty log means the
// round was never created (or the id/join-code was stale) — the one check that has to
// happen before anything else can be reduced out of the log. Returning the raw events
// alongside the fold lets finalizeRound settle over them without a second read.
export interface LoadedRound {
  readonly events: readonly RoundEvent[];
  readonly state: RoundState;
}

export const loadRoundState = async (journal: EventJournal, roundId: RoundId): Promise<LoadedRound> => {
  const events = await journal.read(roundId, 0);
  if (events.length === 0) throw new ApplicationError("round-not-found");
  return { events, state: reduceRound(events) };
};
