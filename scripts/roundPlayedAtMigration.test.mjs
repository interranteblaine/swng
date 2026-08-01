import { describe, it, expect } from "vitest";
import { transformEvent, transformArchive, changed, classifyItems, isoOf, playedDateOf } from "./roundPlayedAtMigration.mjs";

const envelope = (wallMs) => ({ opId: `o${wallMs}`, authorId: "g1", hlc: { deviceId: "server", wallMs, counter: 0 }, seq: 1 });
const card = { courseName: "Casa Verde GC", holes: [{ number: 1, par: 4, strokeIndex: 1 }] };

// A genesis as prod stores it TODAY: no playedAtMs anywhere, and its own hlc.wallMs is the only
// record of when the round happened.
const oldGenesis = { ...envelope(1_700_000_000_000), kind: "round-created", roundId: "r1", card };
const newGenesis = { ...oldGenesis, playedAtMs: 1_700_000_000_000 };

describe("transformEvent", () => {
  it("writes the genesis event's own hlc.wallMs into playedAtMs", () => {
    expect(transformEvent(oldGenesis)).toStrictEqual(newGenesis);
  });

  // The whole claim of this migration is that it is LOSSLESS: `playedAtMsOf` had no fallback arm
  // deleted from under it, because the number written here is exactly the number the (now-deleted)
  // fallback would have computed. That is only true if the source is the event's OWN clock —
  // reading `Date.now()`, or the round's first score, or anything else, would invent a date.
  it("takes the number from the event's own clock, not from anywhere else", () => {
    expect(transformEvent(oldGenesis).playedAtMs).toBe(oldGenesis.hlc.wallMs);
  });

  // THE LOAD-BEARING GUARD. The rule is "the field is absent", never "the field disagrees with the
  // clock". Once the deploy lands, a golfer entering Friday's paper card on Monday stores a
  // playedAtMs three days behind its own hlc.wallMs — that is the entire feature. A transform that
  // re-derived from the clock would silently re-date every back-dated round to its entry time on
  // any subsequent run.
  it("leaves an event that already carries playedAtMs untouched, even if it differs from hlc.wallMs", () => {
    const backDated = { ...oldGenesis, playedAtMs: 1_699_000_000_000 };
    expect(transformEvent(backDated)).toStrictEqual(backDated);
  });

  // 0 is 1970-01-01 — a real instant, and the value a truthiness guard (`!e.playedAtMs`) would
  // read as absent and overwrite. Pinned for the same reason the strokes migration pins a
  // courseHandicap of 0: the difference between "absent" and "falsy" is a silently re-dated round.
  it("treats a playedAtMs of 0 as a real value, not an absent one", () => {
    const epoch = { ...oldGenesis, playedAtMs: 0 };
    expect(transformEvent(epoch)).toStrictEqual(epoch);
  });

  // Refusal beats a guess — the same stance prodStrokesMigration takes on a seat carrying neither
  // number. An event with no usable clock has no honest played date available anywhere, so it is
  // returned untouched, fails HEAD's parse, and lands in the instrument's `unreadable` bucket,
  // which STOPS the run. Writing `playedAtMs: undefined` here would instead produce a record that
  // looks handled and is not.
  it("leaves a genesis with no usable hlc.wallMs alone rather than writing undefined", () => {
    for (const broken of [
      { ...oldGenesis, hlc: undefined },
      { ...oldGenesis, hlc: { deviceId: "server", counter: 0 } },
      { ...oldGenesis, hlc: { deviceId: "server", wallMs: "1700000000000", counter: 0 } },
    ]) {
      expect(transformEvent(broken)).toStrictEqual(broken);
    }
  });

  it("touches no event kind other than round-created", () => {
    for (const other of [
      { ...envelope(2), kind: "participant-joined", participant: { golferId: "g1", name: "Ann", tee: "white", strokes: 0 } },
      { ...envelope(3), kind: "score-recorded", golferId: "g1", hole: 3, result: { kind: "strokes", strokes: 5 } },
      { ...envelope(4), kind: "round-finalized" },
      { ...envelope(5), kind: "round-abandoned" },
      { ...envelope(6), kind: "participant-strokes-set", golferId: "g1", strokes: 12 },
      // The confusable one. A correction CARRIES a playedAtMs of its own and must never be read as
      // a genesis: its number is the golfer's answer, and its hlc.wallMs is when they typed it.
      // Overwriting one with the other is the exact failure this kind check exists to prevent.
      { ...envelope(7), kind: "round-played-at-set", playedAtMs: 1_699_000_000_000 },
    ]) {
      expect(transformEvent(other)).toStrictEqual(other);
    }
  });
});

describe("transformArchive", () => {
  const archive = {
    roundId: "r1",
    card,
    participants: [{ golferId: "g1", name: "Ann", tee: "white", strokes: 0 }],
    games: [],
    cells: { "g1:1": { result: { kind: "strokes", strokes: 4 } } },
    events: [oldGenesis, { ...envelope(2), kind: "round-finalized" }],
    results: [],
    terminatedGameIds: [],
    // Fix wave (Minor 3). WITHOUT this key the passthrough pin below cannot bite: the fixture's key
    // set was exactly `RoundArchive`'s, so a named-field rebuild — `{ roundId, card, participants,
    // games, cells, events, results, terminatedGameIds }` — reproduced it perfectly and the test
    // stayed green. That is the precise failure the instrument's own header warns about: a stored
    // item carries whatever it carries, and rebuilding one from the fields you happened to think of
    // is how an attribute disappears silently. A key no type declares is the only thing a rebuild
    // cannot guess, so the fixture carries one.
    somethingAFutureArcAdded: { nested: [1, 2, 3] },
  };

  it("transforms a snapshot's archived copy of round-created the same way", () => {
    expect(transformArchive(archive).events[0]).toStrictEqual(newGenesis);
  });

  // The write is a whole-attribute replacement, so anything this transform drops is gone from the
  // sealed record. Every field other than `events` must survive byte-identically.
  it("changes nothing about the archive except its events", () => {
    // Put the original `events` back over the result: everything else must then be byte-identical
    // to the archive that went in, so a dropped `terminatedGameIds` or `results` fails here.
    expect({ ...transformArchive(archive), events: archive.events }).toStrictEqual(archive);
  });

  // Idempotence, asserted over a log that MIXES a migrated genesis with a back-dated correction.
  // The back-dated member is what makes this pin falsifiable: over a log where every playedAtMs
  // happens to equal its own hlc.wallMs, deleting the absence guard changes no value and this test
  // would pass with the guard gone.
  it("is idempotent — a second run changes nothing", () => {
    const mixed = {
      ...archive,
      events: [{ ...oldGenesis, playedAtMs: 1_699_000_000_000 }, { ...envelope(2), kind: "round-played-at-set", playedAtMs: 1_698_000_000_000 }],
    };
    const once = transformArchive(mixed);
    expect(transformArchive(once)).toStrictEqual(once);
    expect(once).toStrictEqual(mixed);
  });
});

describe("changed", () => {
  it("is false for equal values", () => {
    expect(changed(newGenesis, { ...newGenesis })).toBe(false);
  });

  it("is true for differing values", () => {
    expect(changed(oldGenesis, newGenesis)).toBe(true);
  });

  // This is what the instrument uses to decide what to write back, so an already-migrated record
  // must read as unchanged — otherwise a re-run puts a no-op write over data it already fixed, and
  // on the snapshots table that no-op write re-fires the projector stream for nothing.
  it("agrees with the transform — false for an already-migrated record", () => {
    expect(changed(newGenesis, transformEvent(newGenesis))).toBe(false);
    expect(changed(oldGenesis, transformEvent(oldGenesis))).toBe(true);
  });
});

// THE BUCKETING RULE, EXECUTED (fix wave, Important 5). This lived inside migrateRoundPlayedAt.mjs
// — a top-level-await CLI no test can import — so all forty pins on it were pins on its source
// TEXT. A whole-branch review measured what that was worth: three separate mutations of it made a
// run print "Nothing to do — deploy" while every record stayed un-migrated, and every pin stayed
// green. Since "a dry run reports 0 pending" IS the close-out's precondition for deploying, a
// self-report was standing in for a check.
//
// `classifyItems` takes its schemas as arguments, so these drive every bucket from the outside with
// stand-ins rather than reaching for a built `packages/contracts/dist`. `safeParse` is the entire
// surface it uses, so nothing here re-implements zod — and the schema stays a controllable input,
// which is what makes "current" and "unreadable" separable at all.
const schemaAccepting = (predicate) => ({
  safeParse: (value) => (predicate(value) ? { success: true } : { success: false, error: { issues: [{ path: ["playedAtMs"], message: "Required" }] } }),
});
// HEAD in one line, on each table: a `round-created` is readable iff it carries a played date, and
// an archive is readable iff every event inside it is.
const headEventSchema = schemaAccepting((event) => event.kind !== "round-created" || typeof event.playedAtMs === "number");
const headArchiveSchema = schemaAccepting((a) => a.events.every((event) => event.kind !== "round-created" || typeof event.playedAtMs === "number"));

const ROUNDS = "swng-rounds-test";
const SNAPSHOTS = "swng-snapshots-test";

const classify = ({ roundsItems = [], snapshotItems = [] }) =>
  classifyItems({
    roundsItems,
    snapshotItems,
    roundsTable: ROUNDS,
    snapshotsTable: SNAPSHOTS,
    roundEventSchema: headEventSchema,
    roundArchiveSchema: headArchiveSchema,
  });

// A stored round as the tables hold it: the event nested under an `event` attribute, plus the key
// attributes and whatever else the item carries.
const roundsItem = (event) => ({ pk: `ROUND#${event.roundId}`, sk: `SEQ#${String(event.seq).padStart(9, "0")}`, event, ttlIsNotAnEventField: 1 });
const snapshotItem = (roundId, events) => ({ pk: `ROUND#${roundId}`, archive: { roundId, card, events, finalizedAt: 5 } });

describe("classifyItems — what a run will actually write", () => {
  // THE PRECONDITION ITSELF. Both tables hold a record this rule changes, so a classification that
  // silently skipped either one would report a smaller write set and, once the last real record was
  // migrated, print "Nothing to do" over records that still need it. Both counts are asserted
  // individually, by table, so a mutation to EITHER loop fails on its own.
  it("buckets an un-migrated event AND an un-migrated snapshot as pending — one per table", () => {
    const { records, currentCount, unreadable, problems } = classify({
      roundsItems: [roundsItem(oldGenesis)],
      snapshotItems: [snapshotItem("r1", [oldGenesis, { ...envelope(2), kind: "round-finalized" }])],
    });

    expect(records.map((r) => r.table)).toStrictEqual([ROUNDS, SNAPSHOTS]);
    expect(records.filter((r) => r.table === ROUNDS)).toHaveLength(1);
    expect(records.filter((r) => r.table === SNAPSHOTS)).toHaveLength(1);
    expect(records.map((r) => r.kind)).toStrictEqual(["round-created", "archive"]);
    expect({ currentCount, unreadable, problems }).toStrictEqual({ currentCount: 0, unreadable: [], problems: [] });
  });

  // Events before snapshots: a snapshot write re-fires the projector stream, and there is no reason
  // to do that before everything else is settled. The instrument writes `records` in the order this
  // returns them, so the order is this function's answer, not the caller's.
  it("orders the write set events-first even when the snapshot was read first", () => {
    const { records } = classify({
      snapshotItems: [snapshotItem("r1", [oldGenesis])],
      roundsItems: [roundsItem(oldGenesis)],
    });
    expect(records.map((r) => r.order)).toStrictEqual([0, 1]);
  });

  // Idempotence, at the bucketing level: this is what makes a re-run a no-op and an interrupted run
  // just a shorter next run. `current` and `pending` must be genuinely different answers — a
  // classification that reported everything pending would put no-op writes back over data it
  // already fixed and, on the snapshots table, re-fire the stream for nothing.
  it("buckets an already-migrated pair as current — nothing to write, and it parses", () => {
    const { records, currentCount, unreadable } = classify({
      roundsItems: [roundsItem(newGenesis)],
      snapshotItems: [snapshotItem("r1", [newGenesis])],
    });
    expect(records).toStrictEqual([]);
    expect(currentCount).toBe(2);
    expect(unreadable).toStrictEqual([]);
  });

  // The third bucket, and the reason "nothing to do" is not one state. A genesis with no usable
  // clock is left alone by the transform (there is no honest played date to invent) AND cannot be
  // read at HEAD — so calling it "already current" would be a lie, and the instrument stops on it.
  // The failing key travels WITH the reason, because "record X is unreadable" with no path is a
  // dead end for whoever has to decide what to do about it.
  it("buckets a record it cannot fix as unreadable — never as current — and names the key", () => {
    const noClock = { ...oldGenesis, hlc: { deviceId: "server", counter: 0 } };
    const { records, currentCount, unreadable } = classify({ roundsItems: [roundsItem(noClock)] });

    expect(records).toStrictEqual([]);
    expect(currentCount).toBe(0);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toContain(ROUNDS);
    expect(unreadable[0]).toContain("ROUND#r1");
    expect(unreadable[0]).toContain("playedAtMs: Required");
  });

  // Everything read is accounted for. A non-candidate is COUNTED and NAMED, never dropped — an
  // instrument that quietly discarded rows could report a complete migration over a table it only
  // partly looked at.
  it("counts and names every row that is not this rule's subject, rather than dropping it", () => {
    const { records, currentCount, unreadable, skipped } = classify({
      roundsItems: [
        { pk: "ROUND#r1", sk: "OPID#abc" },
        { pk: "ROUND#r1", sk: "META" },
        { pk: "ROUND#r1", sk: "LIVE#x" },
        roundsItem({ ...envelope(2), kind: "score-recorded", roundId: "r1", golferId: "g1", hole: 1, result: { kind: "strokes", strokes: 4 } }),
      ],
    });

    expect(records).toStrictEqual([]);
    expect({ currentCount, unreadable }).toStrictEqual({ currentCount: 0, unreadable: [] });
    expect(Object.fromEntries(skipped)).toStrictEqual({
      "OPID# dedup tombstone (carries no event)": 1,
      "META round pointer (carries no event)": 1,
      'other sk "LIVE#x" (carries no event)': 1,
      "score-recorded event (not this rule's subject)": 1,
    });
  });

  // Fix wave (Minor 6). A stored `event: null` is not `undefined`, so it fell through the
  // carries-no-event arm and crashed on `.kind` with a bare TypeError and no key — a stack trace
  // instead of a diagnosis, on a run whose whole job is to tell an operator what is in their table.
  // It is still not this rule's subject; it is just now SAID.
  it("diagnoses a malformed `event` attribute instead of crashing on it", () => {
    const { records, skipped } = classify({
      roundsItems: [
        { pk: "ROUND#r1", sk: "SEQ#1", event: null },
        { pk: "ROUND#r2", sk: "SEQ#1", event: "round-created" },
      ],
    });
    expect(records).toStrictEqual([]);
    expect([...skipped.keys()].sort()).toStrictEqual([
      "malformed `event` attribute (null) — not this rule's subject, and not readable by anything",
      "malformed `event` attribute (string) — not this rule's subject, and not readable by anything",
    ]);
  });

  // A transform that throws stops the run rather than silently dropping the record — and the key
  // travels with the reason, same discipline as `unreadable`.
  it("collects a throwing transform as a keyed problem, on either table", () => {
    const { records, problems } = classify({
      roundsItems: [],
      // `events: null` — `transformArchive` maps over it and throws. The record is neither pending
      // nor current nor unreadable: something is wrong with it that this instrument did not expect.
      snapshotItems: [{ pk: "ROUND#broken", archive: { roundId: "broken", events: null } }],
    });
    expect(records).toStrictEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0].key).toContain("ROUND#broken");
    expect(problems[0].detail).toContain("the transform threw");
  });

  // THE ITEM THAT GETS WRITTEN. Whole-item put, one attribute swapped — asserted over items
  // carrying keys neither type declares (`ttlIsNotAnEventField`, `finalizedAt`), which is the only
  // thing a named-field rebuild cannot reproduce. This is the behavioural half of the two source
  // pins in migrateRoundPlayedAt.test.mjs.
  it("builds the item to write as the READ item with exactly one attribute replaced", () => {
    const read = roundsItem(oldGenesis);
    const readSnapshot = snapshotItem("r1", [oldGenesis]);
    const { records } = classify({ roundsItems: [read], snapshotItems: [readSnapshot] });

    expect(records[0].item).toStrictEqual({ ...read, event: newGenesis });
    expect(records[1].item).toStrictEqual({ ...readSnapshot, archive: { ...readSnapshot.archive, events: [newGenesis] } });
    // Said as a property too, so the pin survives a fixture edit: everything except the one changed
    // attribute is byte-identical to what was read.
    expect({ ...records[0].item, event: read.event }).toStrictEqual(read);
    expect({ ...records[1].item, archive: readSnapshot.archive }).toStrictEqual(readSnapshot);
  });
});

// Fix wave (Minor 6). The instrument's plan loop prints each record's new played date in words, and
// both halves of that line CRASHED rather than diagnosed on inputs that reach it: `new Date(ms)
// .toISOString()` throws a bare RangeError past ±8.64e15 (and `z.number().int()`, the schema a
// played date clears, has no such bound), and `.find` on a non-array/null-bearing `events` threw a
// TypeError. Both abort after the export and before any Put, so neither was ever unsafe — they
// produced a stack trace where the whole job of the routine is to describe what is about to happen.
describe("isoOf / playedDateOf — a diagnosis, never a stack trace", () => {
  it("renders a real instant as an ISO string", () => {
    expect(isoOf(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
  });

  it("names an out-of-Date-range number instead of throwing, and prints the number", () => {
    expect(() => isoOf(8.64e15 + 1)).not.toThrow();
    expect(isoOf(8.64e15 + 1)).toContain("8640000000000001");
    expect(isoOf(8.64e15 + 1)).toContain("outside the range");
    // The boundary itself is a real, expressible instant and must still render.
    expect(isoOf(8.64e15)).toBe("+275760-09-13T00:00:00.000Z");
  });

  it("names a missing or non-numeric played date instead of throwing", () => {
    for (const bad of [undefined, null, NaN, "1700000000000"]) {
      expect(() => isoOf(bad)).not.toThrow();
      expect(isoOf(bad)).toContain("no usable played date");
    }
  });

  it("reads the played date off an events record and out of an archive's genesis", () => {
    expect(playedDateOf({ table: "rounds", after: newGenesis }, "rounds")).toBe(newGenesis.playedAtMs);
    expect(playedDateOf({ table: "snapshots", after: { events: [{ kind: "round-finalized" }, newGenesis] } }, "rounds")).toBe(newGenesis.playedAtMs);
  });

  it("answers undefined for a malformed archive instead of throwing on it", () => {
    for (const after of [{ events: null }, { events: undefined }, { events: [null] }, {}, undefined]) {
      expect(() => playedDateOf({ table: "snapshots", after }, "rounds")).not.toThrow();
      expect(playedDateOf({ table: "snapshots", after }, "rounds")).toBeUndefined();
    }
    // ... and that undefined is what `isoOf` turns into words, so the plan line stays readable.
    expect(isoOf(playedDateOf({ table: "snapshots", after: { events: [null] } }, "rounds"))).toContain("no usable played date");
  });
});
