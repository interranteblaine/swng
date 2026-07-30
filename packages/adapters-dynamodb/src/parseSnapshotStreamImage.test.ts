import { describe, expect, it } from "vitest";
import { marshall } from "@aws-sdk/util-dynamodb";
import { deviceId, fixtureLinks18, golferId, opId, roundId } from "@swng/domain";
import type { RosterEntry, RoundArchive, RoundEvent } from "@swng/domain";
import { snapshotPk } from "./keys.js";
import { parseSnapshotStreamImage } from "./parseSnapshotStreamImage.js";

// Same minimal hand-built archive idiom as application/src/projections/projectionSlice.test.ts
// — no real scoring/handicap math needed here, only that the archive round-trips through
// marshall (what DynamoDB Streams itself does to a NEW_IMAGE) and back.
const ann = golferId("ann");
const finalizedEvent: RoundEvent = {
  kind: "round-finalized",
  opId: opId("finalize-1"),
  hlc: { wallMs: 1_000, counter: 0, deviceId: deviceId("server") },
  authorId: ann,
};
const archive: RoundArchive = {
  roundId: roundId("r1"),
  card: fixtureLinks18,
  // A lone seat is the field's own anchor, so the fold derives 0 strokes for it (spec 2026-07-29 §2b).
  participants: [{ golferId: ann, name: "Ann", tee: "white", basis: { kind: "normally-shoots", overPar: 8 }, strokes: 0 } satisfies RosterEntry],
  games: [],
  cells: {},
  events: [finalizedEvent],
  results: [],
  terminatedGameIds: [],
  handicapping: [{ golferId: ann, kind: "complete", ags: 90, differential: 9.0 }],
};

// Mirrors createDynamoEventJournal's snapshot-leg Item shape — the real producer of what a
// stream NEW_IMAGE for a snapshot record looks like: pk-only (no sk), `finalizedAt`, `archive`.
const snapshotItem = { pk: snapshotPk(archive.roundId), finalizedAt: 1_000, archive };

describe("parseSnapshotStreamImage", () => {
  it("round-trips a marshalled snapshot item back into the same RoundArchive", () => {
    const image = marshall(snapshotItem, { removeUndefinedValues: true });

    expect(parseSnapshotStreamImage(image)).toEqual(archive);
  });

  it("throws when the image is undefined (a REMOVE event, or StreamViewType misconfigured)", () => {
    expect(() => parseSnapshotStreamImage(undefined)).toThrow(/NEW_IMAGE/);
  });

  it("throws when the `archive` attribute is absent (not a snapshot item, or a corrupt one)", () => {
    const image = marshall({ pk: snapshotPk(archive.roundId), finalizedAt: 1_000 }, { removeUndefinedValues: true });

    expect(() => parseSnapshotStreamImage(image)).toThrow(/archive/);
  });
});
