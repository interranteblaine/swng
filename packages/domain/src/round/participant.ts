import type { GolferId } from "../ids.js";

export interface Participant {
  readonly golferId: GolferId;
  readonly name: string;
  readonly tee: string; // TeeSet name within the round's frozen CourseCard
  // ASSERTED, never derived (spec 2026-07-30 §2). 0 until someone sets it. Nothing computes this
  // from anyone else's number: strokes are what the group agreed and typed. Non-negative — the
  // request schema bounds it at min(0), and the card renders dots as "●".repeat(strokes).
  readonly strokes: number;
}

// A participant plus presence — the shape reduceRound puts on the roster and settleRound carries
// into the archive. Seat data (name/tee/strokes) is the participant's LATEST participant-joined,
// amended only by a later participant-strokes-set; `departed` is derived by the fold from the
// HLC-latest of {participant-joined, participant-left} for that golferId. Seat data and presence
// are SEPARATE concerns: a departed golfer still renders with their seat data, and a rejoin (a
// later join) clears `departed` and applies its own seat data.
//
// `departed` is OPTIONAL and only ever set to `true` — its absence IS the default (false), so a
// round with no departures folds and settles byte-identically to one produced before this field
// existed.
export interface RosterEntry extends Participant {
  readonly departed?: boolean;
}
