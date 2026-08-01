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

// THE BUCKETING RULE — which stored items a run will write, which are already right, and which it
// cannot touch. It lives HERE, beside the transform it applies, and the instrument imports it.
//
// It used to live inside migrateRoundPlayedAt.mjs, which is a top-level-await CLI that scans live
// tables the moment it is imported — so no test could execute it, and every pin on it was a pin on
// its SOURCE TEXT. A whole-branch review measured what that bought: three separate mutations
// (iterating an empty snapshot list among them) made a run print "Nothing to do — deploy" while
// leaving every record un-migrated, and all forty pins stayed green. "0 pending" is the close-out's
// own precondition for deploying, so a self-report was standing in for a check. Pure and I/O-free
// like the transform above, for the same reason and now with the same coverage.
//
// Three buckets, because "nothing to do" is not one state but three, and they mean completely
// different things:
//
//   pending    the transform changes it — this is the write set
//   current    the transform leaves it alone AND it parses at HEAD — already in the right shape
//   unreadable the transform leaves it alone and it does NOT parse at HEAD — this migration cannot
//              fix it, and saying "nothing to do" over such a record would be a lie
//
// SCOPE, stated rather than inferred: on the rounds table only `round-created` events are
// candidates, because that is the only kind this rule can touch. Every other event item is counted
// and named in `skipped`, never dropped from the accounting, but it is NOT parsed here — checking
// that every stored item of every kind is readable is a different job with a different instrument
// (scripts/checkProdParses.mjs), and a mutation script that also claimed to be the verification
// gate would be exactly the drift this pure/I-O split exists to prevent. On the snapshots table
// every item is a candidate: the archive is one parse unit and one write unit.
//
// `problems` is returned as a live array on purpose: the instrument's own parse gate appends to it
// after this returns, so there is exactly one list of "records that stop the run" rather than two
// that have to be merged at the reporting site.
export const classifyItems = ({ roundsItems, snapshotItems, roundsTable, snapshotsTable, roundEventSchema, roundArchiveSchema }) => {
  const records = [];
  const problems = [];
  const unreadable = [];
  const skipped = new Map();
  let currentCount = 0;
  const tally = (key) => skipped.set(key, (skipped.get(key) ?? 0) + 1);

  const classify = (table, key, before, after, buildItem, schema, order, kind) => {
    if (changed(before, after)) {
      records.push({ table, key, kind, before, after, item: buildItem(), schema, order });
      return;
    }
    const result = schema.safeParse(before);
    if (result.success) {
      currentCount += 1;
      return;
    }
    // The REASON travels with the key. This bucket stops the run, and "record X is unreadable" with
    // no path is a dead end for whoever has to decide what to do about it — especially on a
    // snapshot, where the cause can be any embedded event of any kind, not the genesis this rule
    // looks at.
    const issues = result.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
    unreadable.push(`${table}  ${key}\n      ${(issues.length > 5 ? [...issues.slice(0, 5), `(+${issues.length - 5} more)`] : issues).join("; ")}`);
  };

  for (const item of roundsItems) {
    // `=== undefined` alone left a stored `event: null` to crash on `.kind` two lines down with a
    // bare TypeError and no key (fix-wave Minor 6). A null or non-object `event` is a real shape a
    // scan can hand back and it is not this rule's subject either way — but it is not the same
    // thing as a tombstone that carries no event at all, so it is counted separately and named,
    // never quietly folded into the tombstone tally.
    if (item.event === null || (item.event !== undefined && typeof item.event !== "object")) {
      tally(`malformed \`event\` attribute (${item.event === null ? "null" : typeof item.event}) — not this rule's subject, and not readable by anything`);
      continue;
    }
    if (item.event === undefined) {
      const sk = String(item.sk ?? "");
      tally(sk.startsWith("OPID#") ? "OPID# dedup tombstone (carries no event)" : sk === "META" ? "META round pointer (carries no event)" : `other sk "${sk}" (carries no event)`);
      continue;
    }
    if (item.event.kind !== "round-created") {
      tally(`${String(item.event.kind)} event (not this rule's subject)`);
      continue;
    }
    let after;
    try {
      after = transformEvent(item.event);
    } catch (error) {
      problems.push({ key: `${roundsTable}  ${item.pk} ${item.sk}`, detail: `the transform threw: ${String(error)}` });
      continue;
    }
    // events first — `order` drives both the write order and the order recorded in the export
    classify(roundsTable, `${item.pk} ${item.sk}`, item.event, after, () => ({ ...item, event: after }), roundEventSchema, 0, "round-created");
  }

  for (const item of snapshotItems) {
    let after;
    try {
      after = transformArchive(item.archive);
    } catch (error) {
      problems.push({ key: `${snapshotsTable}  ${item.pk}`, detail: `the transform threw: ${String(error)}` });
      continue;
    }
    // snapshots last — the stream fires off these
    classify(snapshotsTable, String(item.pk), item.archive, after, () => ({ ...item, archive: after }), roundArchiveSchema, 1, "archive");
  }

  return { records, problems, currentCount, unreadable, skipped };
};

// The played date the instrument's plan prints, in words — because a 13-digit epoch is not
// something anyone can sanity-check by eye, and "is this the date that round was actually played"
// is the one question a reader of the plan can answer and the script cannot.
//
// `new Date(ms).toISOString()` THROWS a bare RangeError past ±8.64e15, and the schema a played date
// clears is `z.number().int()`, which has no such bound — so a record could pass every check in the
// instrument and then blow up its plan with an uncaught stack trace and no key (fix wave, Minor 6).
// It aborted after the export and before any Put, so it was never unsafe; it was a crash where a
// diagnosis belongs. The offending value is PRINTED rather than swallowed: a reader who cannot see
// the number cannot tell a corrupt record from a missing one.
export const isoOf = (ms) => {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return `?? (no usable played date on the transformed record: ${JSON.stringify(ms)})`;
  if (Math.abs(ms) > 8.64e15) return `?? (${ms} is outside the range a date can express — this record needs a person)`;
  return new Date(ms).toISOString();
};

// Where that number lives, per table: on the rounds table it is the event's own field; on the
// snapshots table it is inside the archive's event log. The other half of Minor 6 — a non-array
// `events`, or a null member of one, threw a bare TypeError from inside `.find`, again fail-safe
// and again a stack trace in the middle of a routine that exists to DESCRIBE what is about to
// happen. `undefined` flows into `isoOf` above, which says so in words.
export const playedDateOf = (record, roundsTable) => {
  if (record.table === roundsTable) return record.after?.playedAtMs;
  if (!Array.isArray(record.after?.events)) return undefined;
  return record.after.events.find((event) => event?.kind === "round-created")?.playedAtMs;
};
