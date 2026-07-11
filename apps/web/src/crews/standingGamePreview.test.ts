import { describe, expect, it } from "vitest";
import { golferId } from "@swng/domain";
import type { GolferId } from "@swng/domain";
import { describeStandingGame } from "./standingGamePreview";

const NAMES: Record<string, string> = { a1: "Ann", b1: "Bo", c1: "Cy", d1: "Dee" };
const nameFor = (id: GolferId): string => NAMES[id] ?? id;

// One arm per GameConfigInput kind — the component tests exercise singles/stableford through
// real flows; this pins the remaining kinds' wording too.
describe("describeStandingGame", () => {
  it("names players for the roster-list kinds", () => {
    expect(describeStandingGame({ kind: "stroke-play", scoring: "net", players: [golferId("a1"), golferId("b1")] }, nameFor)).toBe("Stroke play — Ann, Bo");
    expect(describeStandingGame({ kind: "stableford", players: [golferId("a1"), golferId("c1")] }, nameFor)).toBe("Stableford — Ann, Cy");
    expect(describeStandingGame({ kind: "skins", players: [golferId("a1"), golferId("b1"), golferId("c1")] }, nameFor)).toBe("Skins — Ann, Bo, Cy");
  });

  it("names the sides for the match kinds", () => {
    expect(describeStandingGame({ kind: "singles-match", a: golferId("a1"), b: golferId("b1") }, nameFor)).toBe("Singles match — Ann vs Bo");
    expect(describeStandingGame({ kind: "fourball-match", a: [golferId("a1"), golferId("b1")], b: [golferId("c1"), golferId("d1")] }, nameFor)).toBe(
      "Fourball match — Ann & Bo vs Cy & Dee",
    );
  });
});
