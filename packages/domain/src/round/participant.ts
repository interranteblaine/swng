import type { GolferId } from "../ids.js";
import type { StrokeBasis } from "../scoring/strokeBasis.js";

export interface Participant {
  readonly golferId: GolferId;
  readonly name: string;
  readonly tee: string;        // TeeSet name within the round's frozen CourseCard
  readonly basis: StrokeBasis; // what this player ASSERTED — never a derived number
}

// A participant plus presence plus the strokes the fold derived for them — the shape reduceRound
// puts on the roster and settleRound carries into the archive. Seat data (name/tee/basis) is the
// participant's LATEST participant-joined, amended only by a later participant-basis-set;
// `departed` is derived by the fold from the HLC-latest of {participant-joined,
// participant-left} for that golferId. Seat data and presence are SEPARATE concerns: a departed
// golfer still renders with their seat data, and a rejoin (a later join) clears `departed` and
// applies its own seat data.
//
// `departed` is OPTIONAL and only ever set to `true` — its absence IS the default (false), so a
// round with no departures folds and settles byte-identically to one produced before this field
// existed.
export interface RosterEntry extends Participant {
  readonly departed?: boolean;
  // DERIVED by reduceRound across the PRESENT roster (spec 2026-07-29 §2b): the difference from
  // the lowest stated normal score in the field, clamped at zero. No client asserts it and no
  // request body accepts it; the sealed archive freezes it because a snapshot must be
  // self-contained. REQUIRED, unlike `departed` — every folded seat has one, so a bare
  // `Participant` literal is deliberately NOT assignable here: a caller holding only what a
  // player asserted must not be able to pass it off as a scored roster entry.
  readonly strokes: number;
}
