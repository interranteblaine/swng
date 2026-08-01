// The one rule that gives every stored round the played date HEAD requires (spec 2026-08-01 §8).
// Pure and I/O-free on purpose: the script that WRITES a stage's tables and anything that later
// CHECKS them must apply an identical transform, and two copies could drift invisibly.
//
// THE RULE, in one sentence: on a `round-created` event with no `playedAtMs`, set `playedAtMs` to
// that same event's own `hlc.wallMs`.
//
// It is LOSSLESS BY DEFINITION, and that is the whole reason this migration is allowed to exist
// rather than a tolerate arm. `playedAtMs` was made REQUIRED on `round-created` with no fallback
// anywhere; the number written here is exactly the number that deleted fallback would have
// computed, because until this arc a round WAS dated by its genesis clock. Nothing is invented and
// nothing is chosen — every migrated round keeps the date it already had on screen.
//
// Guarded on the field being ABSENT, never on it disagreeing with the clock. That distinction is
// load-bearing, not defensive coding: once the deploy lands, a golfer entering Friday's paper card
// on Monday stores a `playedAtMs` three days behind its own `hlc.wallMs` — that gap IS the
// feature. A transform keyed on the disagreement would silently re-date every back-dated round to
// its entry time. Because the guard is absence, the transform is idempotent: a re-run is a no-op
// and an interrupted run is just a shorter next run.
//
// An event with no usable clock is left completely alone rather than given `playedAtMs: undefined`.
// There is no honest played date available for such a record, and a fabricated one turns something
// unreadable into something confidently wrong. Left untouched it fails HEAD's parse and lands in
// the instrument's `unreadable` bucket, which stops the run and asks for a person — the same stance
// prodStrokesMigration.mjs takes on a seat carrying neither number.

export const transformEvent = (e) => {
  if (e.kind !== "round-created") return e;
  // `!== undefined` rather than a truthiness check: 0 is 1970-01-01, a real instant, and
  // `!e.playedAtMs` would read it as absent and overwrite it.
  if (e.playedAtMs !== undefined) return e;
  const wallMs = e.hlc?.wallMs;
  if (typeof wallMs !== "number") return e;
  return { ...e, playedAtMs: wallMs };
};

// A snapshot's archive holds its round's whole event log, genesis included, and `playedAtMsOf`
// reads the played date out of exactly that. Only `events` is rebuilt — every other field of the
// sealed record passes through by spread, because the instrument writes this back as a whole
// attribute and anything dropped here is gone from the archive.
export const transformArchive = (a) => ({ ...a, events: a.events.map(transformEvent) });

// True iff the transform would actually change this value — the instrument uses it to decide what
// to write, so an unchanged record is never put back over itself.
export const changed = (before, after) => JSON.stringify(before) !== JSON.stringify(after);
