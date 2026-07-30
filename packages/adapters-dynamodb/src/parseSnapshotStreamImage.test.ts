import { describe, expect, it } from "vitest";
import { marshall } from "@aws-sdk/util-dynamodb";
import { deviceId, fixtureLinks, fixtureLinks18, gameId, golferId, opId, playGoldenRoundLog, roundId, settleRound } from "@swng/domain";
import type { Participant, RosterEntry, RoundArchive, RoundEvent } from "@swng/domain";
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
  // A seat nobody typed a number onto sits on its default 0 strokes (spec 2026-07-30 §2).
  participants: [{ golferId: ann, name: "Ann", tee: "white", strokes: 0 } satisfies RosterEntry],
  games: [],
  cells: {},
  events: [finalizedEvent],
  results: [],
  terminatedGameIds: [],
};

// Mirrors createDynamoEventJournal's snapshot-leg Item shape — the real producer of what a
// stream NEW_IMAGE for a snapshot record looks like: pk-only (no sk), `finalizedAt`, `archive`.
const snapshotItem = { pk: snapshotPk(archive.roundId), finalizedAt: 1_000, archive };

describe("parseSnapshotStreamImage", () => {
  it("round-trips a marshalled snapshot item back into the same RoundArchive", () => {
    const image = marshall(snapshotItem, { removeUndefinedValues: true });

    expect(parseSnapshotStreamImage(image)).toEqual(archive);
  });

  // All three failure modes carry ONE named code (the function's own doc explains why) — pinned
  // here so a future edit can't quietly reintroduce an anonymous `Error` beside a named one.
  it("throws when the image is undefined (a REMOVE event, or StreamViewType misconfigured)", () => {
    expect(() => parseSnapshotStreamImage(undefined)).toThrow(/NEW_IMAGE/);
    expect(() => parseSnapshotStreamImage(undefined)).toThrow(/stored-archive-invalid/);
  });

  it("throws when the `archive` attribute is absent (not a snapshot item, or a corrupt one)", () => {
    const image = marshall({ pk: snapshotPk(archive.roundId), finalizedAt: 1_000 }, { removeUndefinedValues: true });

    expect(() => parseSnapshotStreamImage(image)).toThrow(/archive/);
    expect(() => parseSnapshotStreamImage(image)).toThrow(/stored-archive-invalid/);
  });

  // Spec 2026-07-30 §10: the archive is PARSED now, not asserted. These two tests are the pair
  // that makes that safe — one proves it accepts what settleRound actually produces (a parse the
  // projector rejects is a DLQ'd finalize, so this is the load-bearing half), the other proves it
  // refuses what the old cast waved through.
  it("accepts a REAL settled archive — a full round through the golden deck, marshalled as a stream image", () => {
    const bo = golferId("bo");
    const players: readonly Participant[] = [
      { golferId: ann, name: "Ann", tee: "white", strokes: 0 },
      { golferId: bo, name: "Bo", tee: "white", strokes: 6 },
    ];
    const settled = settleRound(
      playGoldenRoundLog(
        fixtureLinks,
        players,
        [
          { kind: "singles-match", id: gameId("m1"), a: ann, b: bo },
          { kind: "skins", id: gameId("s1"), scoring: "net", players: [ann, bo] },
          { kind: "stableford", id: gameId("st1"), players: [ann, bo] },
        ],
        { [ann]: [4, 5, 4, 5, 4, 4, 5, 5, 4], [bo]: [5, 5, 5, 6, 5, "picked-up", 5, 6, 5] },
      ),
    );
    // Not a hand-built shape: participants, three game configs, 18 cells (one carrying a pickup),
    // three results and the whole event log all came out of the real engines.
    expect(settled.results).toHaveLength(3);

    const image = marshall({ pk: snapshotPk(settled.roundId), finalizedAt: 1_000, archive: settled }, { removeUndefinedValues: true });

    expect(parseSnapshotStreamImage(image)).toEqual(settled);
  });

  it("rejects an archive whose participant carries no strokes — the field the cast used to wave through", () => {
    const corrupt = { ...archive, participants: [{ golferId: ann, name: "Ann", tee: "white" }] };
    const image = marshall({ pk: snapshotPk(archive.roundId), finalizedAt: 1_000, archive: corrupt }, { removeUndefinedValues: true });

    expect(() => parseSnapshotStreamImage(image)).toThrow(/stored-archive-invalid/);
  });
});
