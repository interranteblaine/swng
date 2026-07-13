import type { PeekRoundResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { RoundStore } from "../ports/roundStore.js";
import { loadRoundState } from "./loadRoundState.js";

// A pre-join preview of the round, by join code — lets a would-be joiner pick a tee before
// committing to JoinRound. Deliberately minimal (capability discipline): the frozen card's
// courseName and tee-rating summaries only, nothing about who's already in the round or how
// it's being scored — see courses.ts' PeekRoundResponse doc comment for the exact contract.
//
// Reuses loadRoundState (the same journal read + reduceRound every other round use case
// goes through) rather than hand-rolling a genesis-only scan: RoundState.card IS the
// genesis event's card, verbatim and unchanging for the round's whole life (round-created
// is the only writer of that field — see domain's reduceRound), so this is just a thinner
// read of the same fact, not a second source of truth for it.
export const peekRound =
  (deps: { journal: EventJournal; store: RoundStore }) =>
  async (code: string): Promise<PeekRoundResponse> => {
    const id = await deps.store.findByJoinCode(code);
    if (!id) throw new ApplicationError("bad-join-code"); // unknown code — same shape as joinRound's

    const { state, events } = await loadRoundState(deps.journal, id);
    // createdAt (accounts-only identity spec §5, the "course + date" designation): the round-created
    // event's own wall time. round-created is the genesis of every non-empty log (loadRoundState
    // already threw on an empty one), so it is always present — the `!` is that invariant, not a
    // guess, mirroring finalizedAtMsOf's own "a settled archive without one is corrupt" stance.
    const genesis = events.find((event) => event.kind === "round-created")!;
    return {
      courseName: state.card.courseName,
      teeSets: state.card.teeSets.map((tee) => ({ name: tee.name, rating: tee.rating, slope: tee.slope })),
      createdAt: genesis.hlc.wallMs,
    };
  };
