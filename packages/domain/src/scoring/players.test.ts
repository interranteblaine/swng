import { describe, expect, it } from "vitest";
import { deviceId, golferId, opId } from "../ids.js";
import type { RoundEvent } from "../round/events.js";
import type { Participant } from "../round/participant.js";
import { reduceRound } from "../round/state.js";
import { playGoldenRoundLog } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";
import { allPlayersComplete } from "./players.js";

const A = golferId("ann");
const B = golferId("bo");
const players2: readonly Participant[] = [
  { golferId: A, name: "Ann", tee: "white", strokes: 3 },
  { golferId: B, name: "Bo", tee: "white", strokes: 0 },
];

describe("allPlayersComplete", () => {
  it("true once every player has a cell for every hole on their own tee", () => {
    const log = playGoldenRoundLog(
      fixtureLinks, players2, [],
      { [A]: [4, 5, 3, 6, 4, 3, 5, 5, 4], [B]: [5, 4, 4, 5, 4, 4, 4, 6, 5] },
      [], false,
    );
    const state = reduceRound(log);
    expect(allPlayersComplete(state, [A, B])).toBe(true);
  });

  it("false when any player has an unrecorded hole", () => {
    const log = playGoldenRoundLog(fixtureLinks, players2, [], { [A]: [4, 5, 3, 6, 4, 3, 5, 5, 4], [B]: [5, 4] }, [], false);
    const state = reduceRound(log);
    expect(allPlayersComplete(state, [A, B])).toBe(false);
  });

  it("a cleared cell makes the card incomplete", () => {
    // A full, complete card, then a clear on Ann's last hole (a later hlc) — completeness
    // must read as incomplete again, exactly as if that hole had never been recorded.
    const log = playGoldenRoundLog(
      fixtureLinks, players2, [],
      { [A]: [4, 5, 3, 6, 4, 3, 5, 5, 4], [B]: [5, 4, 4, 5, 4, 4, 4, 6, 5] },
      [], false,
    );
    const clearAnnH9: RoundEvent = {
      kind: "score-recorded", golferId: A, hole: 9, result: { kind: "cleared" },
      opId: opId("clear-ann-h9"), hlc: { wallMs: 9_999, counter: 0, deviceId: deviceId("clear-device") }, authorId: A,
    };
    const state = reduceRound([...log, clearAnnH9]);
    expect(allPlayersComplete(state, [A, B])).toBe(false);
  });
});
