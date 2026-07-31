import { describe, it, expect } from "vitest";
import { seat, migrateEvent, migrateArchive, changed } from "./prodStrokesMigration.mjs";

const oldSeat = { name: "Blaine", courseHandicap: 21, tee: "White", golferId: "g1" };
const newSeat = { name: "Blaine", tee: "White", golferId: "g1", strokes: 21 };
const envelope = { opId: "o1", authorId: "g1", hlc: { deviceId: "server", wallMs: 1, counter: 0 }, seq: 2 };

describe("seat", () => {
  it("renames courseHandicap to strokes", () => {
    expect(seat(oldSeat)).toStrictEqual(newSeat);
  });

  it("leaves an already-migrated seat alone", () => {
    expect(seat(newSeat)).toStrictEqual(newSeat);
  });

  it("leaves a seat carrying BOTH alone — strokes already wins, and guessing would be worse", () => {
    const both = { ...newSeat, courseHandicap: 99 };
    expect(seat(both)).toStrictEqual(both);
  });

  it("leaves a seat carrying NEITHER alone rather than inventing a 0", () => {
    const neither = { name: "Blaine", tee: "White", golferId: "g1" };
    expect(seat(neither)).toStrictEqual(neither);
  });

  // Production has a participant seated at exactly 0 — a legitimate value, not an absent one.
  // `!== undefined` handles it correctly today; this pins that so a future edit toward
  // `!courseHandicap` or a truthiness check (which would silently drop this player) fails loudly.
  it("renames a courseHandicap of 0 to a strokes of 0 — a real seat, not a missing value", () => {
    const zeroSeat = { name: "Blaine", courseHandicap: 0, tee: "White", golferId: "g1" };
    expect(seat(zeroSeat)).toStrictEqual({ name: "Blaine", tee: "White", golferId: "g1", strokes: 0 });
  });
});

describe("migrateEvent", () => {
  it("renames the kind AND the field on a correction", () => {
    expect(migrateEvent({ ...envelope, kind: "participant-handicap-set", golferId: "g1", courseHandicap: 20 })).toStrictEqual({
      ...envelope,
      kind: "participant-strokes-set",
      golferId: "g1",
      strokes: 20,
    });
  });

  it("migrates the seat inside a join", () => {
    expect(migrateEvent({ ...envelope, kind: "participant-joined", participant: oldSeat }).participant).toStrictEqual(newSeat);
  });

  it("passes every other kind through byte-identically", () => {
    const score = { ...envelope, kind: "score-recorded", golferId: "g1", hole: 3, result: { kind: "strokes", strokes: 5 } };
    expect(migrateEvent(score)).toStrictEqual(score);
  });

  // The correction rule must not fire on the kind alone — otherwise an event that already
  // carries `strokes` under the old kind gets that value silently clobbered with `undefined`.
  // Guarded the same way `seat` is guarded, so both of these pass through completely untouched,
  // kind included: an anomaly like this should make a stored-event parse refuse loudly, not have
  // this transform guess for it.
  it("leaves a correction alone if it already carries strokes — kind included, nothing guessed", () => {
    const already = { ...envelope, kind: "participant-handicap-set", golferId: "g1", strokes: 15 };
    expect(migrateEvent(already)).toStrictEqual(already);
  });

  it("leaves a correction alone if it carries neither number — refusal beats a guess", () => {
    const neither = { ...envelope, kind: "participant-handicap-set", golferId: "g1" };
    expect(migrateEvent(neither)).toStrictEqual(neither);
  });

  it("is idempotent on every kind", () => {
    for (const e of [
      { ...envelope, kind: "participant-handicap-set", golferId: "g1", courseHandicap: 20 },
      { ...envelope, kind: "participant-joined", participant: oldSeat },
    ]) {
      const once = migrateEvent(e);
      expect(migrateEvent(once)).toStrictEqual(once);
    }
  });
});

describe("migrateArchive", () => {
  it("migrates the roster AND the events embedded inside it", () => {
    const archive = {
      roundId: "r1",
      participants: [oldSeat],
      events: [{ ...envelope, kind: "participant-handicap-set", golferId: "g1", courseHandicap: 20 }],
    };
    const out = migrateArchive(archive);
    expect(out.participants).toStrictEqual([newSeat]);
    expect(out.events[0]).toMatchObject({ kind: "participant-strokes-set", strokes: 20 });
    expect(migrateArchive(out)).toStrictEqual(out);
  });
});

describe("changed", () => {
  it("is false for equal values", () => {
    expect(changed(newSeat, { ...newSeat })).toBe(false);
  });

  it("is true for differing values", () => {
    expect(changed(oldSeat, newSeat)).toBe(true);
  });

  // This is what the migration script itself uses to decide what to write back, so an
  // already-migrated record must read as unchanged — otherwise a re-run puts a no-op write over
  // data it already fixed.
  it("agrees with the transform — false for an already-migrated record", () => {
    const migrated = { ...envelope, kind: "participant-strokes-set", golferId: "g1", strokes: 20 };
    expect(changed(migrated, migrateEvent(migrated))).toBe(false);
  });
});
