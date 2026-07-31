import { describe, it, expect } from "vitest";
import { seat, migrateEvent, migrateArchive } from "./prodStrokesMigration.mjs";

const oldSeat = { name: "Blaine", courseHandicap: 21, tee: "White", golferId: "g1" };
const newSeat = { name: "Blaine", tee: "White", golferId: "g1", strokes: 21 };
const envelope = { opId: "o1", authorId: "g1", hlc: { deviceId: "server", wallMs: 1, counter: 0 }, seq: 2 };

describe("seat", () => {
  it("renames courseHandicap to strokes", () => {
    expect(seat(oldSeat)).toEqual(newSeat);
  });

  it("leaves an already-migrated seat alone", () => {
    expect(seat(newSeat)).toEqual(newSeat);
  });

  it("leaves a seat carrying BOTH alone — strokes already wins, and guessing would be worse", () => {
    const both = { ...newSeat, courseHandicap: 99 };
    expect(seat(both)).toEqual(both);
  });

  it("leaves a seat carrying NEITHER alone rather than inventing a 0", () => {
    const neither = { name: "Blaine", tee: "White", golferId: "g1" };
    expect(seat(neither)).toEqual(neither);
  });
});

describe("migrateEvent", () => {
  it("renames the kind AND the field on a correction", () => {
    expect(migrateEvent({ ...envelope, kind: "participant-handicap-set", golferId: "g1", courseHandicap: 20 })).toEqual({
      ...envelope,
      kind: "participant-strokes-set",
      golferId: "g1",
      strokes: 20,
    });
  });

  it("migrates the seat inside a join", () => {
    expect(migrateEvent({ ...envelope, kind: "participant-joined", participant: oldSeat }).participant).toEqual(newSeat);
  });

  it("passes every other kind through byte-identically", () => {
    const score = { ...envelope, kind: "score-recorded", golferId: "g1", hole: 3, result: { kind: "strokes", strokes: 5 } };
    expect(migrateEvent(score)).toEqual(score);
  });

  it("is idempotent on every kind", () => {
    for (const e of [
      { ...envelope, kind: "participant-handicap-set", golferId: "g1", courseHandicap: 20 },
      { ...envelope, kind: "participant-joined", participant: oldSeat },
    ]) {
      const once = migrateEvent(e);
      expect(migrateEvent(once)).toEqual(once);
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
    expect(out.participants).toEqual([newSeat]);
    expect(out.events[0]).toMatchObject({ kind: "participant-strokes-set", strokes: 20 });
    expect(migrateArchive(out)).toEqual(out);
  });
});
