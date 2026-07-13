import type { GolferId } from "../ids.js";

export interface Participant {
  readonly golferId: GolferId;
  readonly name: string;
  readonly tee: string;            // TeeSet name within the round's frozen CourseCard
  readonly courseHandicap: number; // frozen at join; negative = plus handicap
}

// A participant plus presence — the shape reduceRound puts on the roster and settleRound
// carries into the archive. Seat data (name/tee/courseHandicap) is the participant's LATEST
// participant-joined; `departed` is derived by the fold from the HLC-latest of
// {participant-joined, participant-left} for that golferId. Seat data and presence are
// SEPARATE concerns: a departed golfer still renders with their seat data, and a rejoin
// (a later join) clears `departed` and applies its own seat data.
//
// `departed` is OPTIONAL and only ever set to `true` — its absence IS the default (false).
// Two things fall out of that: (1) a Participant is assignable to a RosterEntry, so every
// existing `Participant`-shaped literal keeps compiling with no change; (2) a round with no
// departures folds and settles byte-identically to one produced before this field existed —
// old snapshots deserialize unchanged.
export interface RosterEntry extends Participant {
  readonly departed?: boolean;
}
