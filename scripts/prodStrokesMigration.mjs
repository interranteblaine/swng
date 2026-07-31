// The two rename rules that move a prod record written by the 2026-07-24 launch build onto the
// shape HEAD reads. Pure and I/O-free on purpose: the script that WRITES prod and the script that
// CHECKS prod must apply an identical transform, and two copies could drift invisibly.
//
// Every rule is guarded on the old shape actually being present, which is what makes the whole
// migration idempotent — an already-migrated record passes through untouched, so a re-run is a
// no-op and an interrupted run is just a shorter next run.
//
// A record carrying NEITHER field is left alone rather than defaulted to 0. Zero is a legal,
// meaningful strokes value, so inventing one would turn an unreadable record into a confidently
// wrong one — and the schema refusing it is the outcome we want.

export const seat = (p) =>
  p && p.courseHandicap !== undefined && p.strokes === undefined
    ? (({ courseHandicap, ...rest }) => ({ ...rest, strokes: courseHandicap }))(p)
    : p;

export const migrateEvent = (e) => {
  if (e.kind === "participant-joined") return { ...e, participant: seat(e.participant) };
  if (e.kind === "participant-handicap-set") {
    // Not destructuring `kind` out here: the explicit `kind:` below already overrides
    // whatever `rest` carries (object literals let a later key win), and destructuring it
    // only to discard it left a var eslint's no-unused-vars correctly flagged.
    const { courseHandicap, ...rest } = e;
    return { ...rest, kind: "participant-strokes-set", strokes: courseHandicap };
  }
  return e;
};

export const migrateArchive = (a) => ({
  ...a,
  participants: a.participants.map(seat),
  events: a.events.map(migrateEvent),
});

// True iff the transform would actually change this value — the script uses it to decide what to
// write, so an unchanged record is never put back over itself.
export const changed = (before, after) => JSON.stringify(before) !== JSON.stringify(after);
