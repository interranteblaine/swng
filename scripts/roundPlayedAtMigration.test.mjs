import { describe, it, expect } from "vitest";
import { transformEvent, transformArchive, changed } from "./roundPlayedAtMigration.mjs";

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
