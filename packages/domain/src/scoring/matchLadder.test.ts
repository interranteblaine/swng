import { describe, expect, it } from "vitest";
import { matchLadder } from "./matchLadder.js";

describe("matchLadder", () => {
  it("tracks up/thru/remaining with no outcome mid-match", () => {
    const state = matchLadder(["a", "a", "halved", "a"], 9);
    expect(state).toMatchObject({ up: 3, leader: "a", thru: 4, remaining: 5 });
    expect(state.outcome).toBeUndefined();
  });

  it("closes out '3&2' when up exceeds remaining before the last hole", () => {
    // a,a,a → 3 up thru 3; four halves run the prefix to thru 7 (up stays 3,
    // remaining 2) where 3 > 2 triggers the general closeout rule.
    const state = matchLadder(["a", "a", "a", "halved", "halved", "halved", "halved"], 9);
    expect(state).toMatchObject({ up: 3, leader: "a", thru: 7, remaining: 2, outcome: { winner: "a", closing: "3&2" } });
  });

  it("a win sealed on the last hole reads '1 up', not '1&0'", () => {
    const state = matchLadder(["halved", "halved", "halved", "halved", "halved", "halved", "halved", "halved", "a"], 9);
    expect(state).toMatchObject({ up: 1, leader: "a", thru: 9, remaining: 0, outcome: { winner: "a", closing: "1 up" } });
  });

  it("nine decided holes all halved ends the match halved", () => {
    const state = matchLadder(Array(9).fill("halved") as ("halved" | undefined)[], 9);
    expect(state).toMatchObject({ up: 0, thru: 9, remaining: 0, outcome: { halved: true } });
    expect(state.leader).toBeUndefined();
  });

  it("reports all square, nothing decided, for an empty winners array", () => {
    const state = matchLadder([], 9);
    expect(state).toMatchObject({ up: 0, thru: 0, remaining: 9, dormie: false });
    expect(state.leader).toBeUndefined();
    expect(state.outcome).toBeUndefined();
  });

  it("stops the decided prefix at the first undefined — a gap pauses the ladder", () => {
    const state = matchLadder(["a", undefined, "a"], 9);
    expect(state).toMatchObject({ up: 1, leader: "a", thru: 1, remaining: 8 });
    expect(state.outcome).toBeUndefined();
  });

  it("calls dormie when up equals remaining and the match isn't closed", () => {
    // a,a → 2 up thru 2; five halves run the prefix to thru 7, remaining 2 — dormie.
    const state = matchLadder(["a", "a", "halved", "halved", "halved", "halved", "halved"], 9);
    expect(state).toMatchObject({ up: 2, leader: "a", thru: 7, remaining: 2, dormie: true });
    expect(state.outcome).toBeUndefined();
  });

  it("ignores winners recorded after closeout", () => {
    const closedEarly = matchLadder(["a", "a", "a", "halved", "halved", "halved", "halved"], 9);
    const withJunkAfter = matchLadder(["a", "a", "a", "halved", "halved", "halved", "halved", "b", "b"], 9);
    expect(withJunkAfter).toEqual(closedEarly);
  });
});
