import { describe, expect, it } from "vitest";
import { marshall } from "@aws-sdk/util-dynamodb";
import { deviceId, fixtureLinks18, golferId, opId, roundId } from "@swng/domain";
import type { Participant, RoundArchive, RoundEvent } from "@swng/domain";
import { archiveSk, roundPk } from "./keys.js";
import { parseArchiveStreamImage } from "./parseArchiveStreamImage.js";

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
  participants: [{ golferId: ann, name: "Ann", tee: "white", courseHandicap: 8 } satisfies Participant],
  games: [],
  cells: {},
  events: [finalizedEvent],
  results: [],
  terminatedGameIds: [],
  handicapping: [{ golferId: ann, kind: "complete", ags: 90, differential: 9.0 }],
};

// Mirrors createDynamoRoundStore.putArchive's exact Item shape — the real producer of what a
// stream NEW_IMAGE for an ARCHIVE record looks like.
const archiveItem = { pk: roundPk(archive.roundId), sk: archiveSk, archive };

describe("parseArchiveStreamImage", () => {
  it("round-trips a marshalled ARCHIVE item back into the same RoundArchive", () => {
    const image = marshall(archiveItem, { removeUndefinedValues: true });

    expect(parseArchiveStreamImage(image)).toEqual(archive);
  });

  it("throws when the image is undefined (a REMOVE event, or StreamViewType misconfigured)", () => {
    expect(() => parseArchiveStreamImage(undefined)).toThrow(/NEW_IMAGE/);
  });

  it("throws when sk isn't ARCHIVE (a filter-criteria miss, or a non-archive record reaching the projector)", () => {
    const image = marshall({ pk: roundPk(archive.roundId), sk: "META", roundId: archive.roundId, joinCode: "ABC123" }, { removeUndefinedValues: true });

    expect(() => parseArchiveStreamImage(image)).toThrow(/expected sk "ARCHIVE"/);
  });
});
