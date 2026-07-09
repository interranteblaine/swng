import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureWhite, golferId } from "@swng/domain";
import type { HoleResult, Participant } from "@swng/domain";
import { orderedStrokeValues, ScorePad } from "./ScorePad";

const ANN: Participant = { golferId: golferId("ann"), name: "Ann", tee: "white", courseHandicap: 8 };
const HOLE_PAR4 = fixtureWhite.holes[0]!; // hole 1: par 4

afterEach(() => cleanup());

describe("orderedStrokeValues", () => {
  it("orders 1..9 by distance from par, closer values first, ties broken toward the lower value", () => {
    // par 4 distances: 4(0) 3/5(1) 2/6(2) 1/7(3) 8(4) 9(5) — ties (3 vs 5, etc.) go to the smaller value.
    expect(orderedStrokeValues(4)).toEqual([4, 3, 5, 2, 6, 1, 7, 8, 9]);
  });

  it("still covers every value 1..9 exactly once for a par at the edge of the range", () => {
    const values = orderedStrokeValues(3);
    expect([...values].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("ScorePad", () => {
  it("renders value buttons par-first, plus Picked up, Conceded, and a cancel affordance", () => {
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons[0]).toBe("4"); // par-first ordering
    expect(buttons).toContain("Picked up");
    expect(buttons).toContain("Conceded");
    expect(screen.getByRole("button", { name: /clear selection/i })).toBeTruthy();
  });

  it("every value/Picked up/Conceded button meets the 56px touch-target sizing", () => {
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    // Tailwind's h-14/min-h-14 = 56px — asserted via the class name itself (jsdom doesn't
    // compute real layout), matching the brief's "≥56px, Tailwind sizing" contract.
    for (const label of ["4", "Picked up", "Conceded"]) {
      const button = screen.getByRole("button", { name: label });
      expect(button.className).toMatch(/min-h-14/);
    }
  });

  it("tapping a value posts { kind: 'strokes', strokes: N } and nothing else", () => {
    const onSubmit = vi.fn<(result: HoleResult) => void>();
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "6" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ kind: "strokes", strokes: 6 });
  });

  it("tapping Picked up / Conceded posts the matching first-class result", () => {
    const onSubmit = vi.fn<(result: HoleResult) => void>();
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Picked up" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ kind: "picked-up" });

    fireEvent.click(screen.getByRole("button", { name: "Conceded" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ kind: "conceded" });
  });

  it("tapping Clear selection cancels without posting anything", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} onSubmit={onSubmit} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: /clear selection/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
