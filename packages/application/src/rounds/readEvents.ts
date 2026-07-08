import type { RoundId } from "@swng/domain";
import type { EventsResponse } from "@swng/contracts";
import type { EventJournal } from "../ports/eventJournal.js";

// The catch-up query behind GET /rounds/{id}/events?since=N — HTTP catch-up is the
// correctness path (architecture.md §3), so this is a thin pass-through over the journal,
// not a reducer: callers fold the events themselves if they need state.
export const readEvents =
  (deps: { journal: EventJournal }) =>
  async (roundIdValue: RoundId, sinceSeq: number): Promise<EventsResponse> => {
    const events = await deps.journal.read(roundIdValue, sinceSeq);
    const last = events.at(-1);
    // Events returned by the journal are always already seq-stamped; the fallback to
    // sinceSeq only fires on an empty page, keeping the client's cursor unchanged.
    const nextSeq = last?.seq ?? sinceSeq;
    return { events, nextSeq };
  };
