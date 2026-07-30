import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureWhite, golferId } from "@swng/domain";
import type { HoleResult, Participant } from "@swng/domain";
import { orderedStrokeValues, ScorePad } from "./ScorePad";

const ANN: Participant = { golferId: golferId("ann"), name: "Ann", tee: "white", basis: { kind: "normally-shoots", overPar: 8 } };
const HOLE_PAR4 = fixtureWhite.holes[0]!; // hole 1: par 4

afterEach(() => cleanup());

describe("orderedStrokeValues", () => {
  it("orders 1..12 by distance from par, closer values first, ties broken toward the lower value", () => {
    // par 4 distances: 4(0) 3/5(1) 2/6(2) 1/7(3) 8(4) 9(5) 10(6) 11(7) 12(8) — ties go to the smaller value.
    expect(orderedStrokeValues(4)).toEqual([4, 3, 5, 2, 6, 1, 7, 8, 9, 10, 11, 12]);
  });

  it("still covers every value 1..12 exactly once for a par at the edge of the range", () => {
    const values = orderedStrokeValues(3);
    expect([...values].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe("ScorePad", () => {
  it("renders value buttons 1-12 par-first, plus Picked up, Conceded, and a cancel affordance", () => {
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons[0]).toBe("4"); // par-first ordering
    // gross 10-12 are routine for a high-handicap golfer on a hard hole — every value up to
    // the v1 cap must be one tap away, same as any other value.
    for (const value of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) expect(buttons).toContain(String(value));
    expect(buttons).toContain("Picked up");
    expect(buttons).toContain("Conceded");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("renders exactly 14 buttons (12 values + Picked up + Conceded) in the value grid", () => {
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    // 15 total on the sheet: the 14-button value grid plus the separate Cancel button.
    expect(screen.getAllByRole("button")).toHaveLength(15);
  });

  it("every value/Picked up/Conceded button meets the 56px touch-target sizing", () => {
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    // Tailwind's h-14/min-h-14 = 56px — asserted via the class name itself (jsdom doesn't
    // compute real layout), matching the brief's "≥56px, Tailwind sizing" contract.
    for (const label of ["4", "10", "11", "12", "Picked up", "Conceded"]) {
      const button = screen.getByRole("button", { name: label });
      expect(button.className).toMatch(/min-h-14/);
    }
  });

  it("tapping a two-digit value posts { kind: 'strokes', strokes: N } in one tap, same as any other value", () => {
    const onSubmit = vi.fn<(result: HoleResult) => void>();
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "12" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ kind: "strokes", strokes: 12 });
  });

  it("tapping a value posts { kind: 'strokes', strokes: N } and nothing else", () => {
    const onSubmit = vi.fn<(result: HoleResult) => void>();
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "6" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ kind: "strokes", strokes: 6 });
  });

  it("tapping Picked up posts the first-class result in one tap", () => {
    const onSubmit = vi.fn<(result: HoleResult) => void>();
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Picked up" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ kind: "picked-up" });
  });

  it("tapping Cancel closes without posting anything", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} onSubmit={onSubmit} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// Conceded is a disclosure, not a one-tap post (task-2, spec §2d) — a deliberate deviation from
// product.md §9's two-tap rule for a rarer, more deliberate act: scoring stays two taps,
// conceding costs three (cell → Conceded → the number).
describe("ScorePad — Conceded (a disclosure, not a one-tap post)", () => {
  it("tapping Conceded reveals the same number row asking what you would have made, without posting", () => {
    const onSubmit = vi.fn();
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Conceded" }));

    expect(onSubmit).not.toHaveBeenCalled(); // a disclosure, not a post
    expect(screen.getByText("Conceded — what would you have made?")).toBeTruthy();
    // The same par-first number row, still one tap away.
    for (const value of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(screen.getByRole("button", { name: String(value) })).toBeTruthy();
    }
  });

  it("tapping a number after Conceded posts { kind: 'conceded', strokes: N } — three taps, not two", () => {
    const onSubmit = vi.fn<(result: HoleResult) => void>();
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Conceded" })); // tap 2 (tap 1 is the cell, one level up)
    fireEvent.click(screen.getByRole("button", { name: "5" })); // tap 3

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ kind: "conceded", strokes: 5 });
  });

  it("Cancel from inside the Conceded disclosure still backs out without posting anything", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} onSubmit={onSubmit} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: "Conceded" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// A mis-tap is removable: `Clear score` posts { kind: "cleared" } — a real event through the
// same onSubmit path as any other tap, folded/rendered as unscored everywhere (round/state.ts's
// cellAt). Distinct from `Cancel` above, which backs out of the pad without posting
// anything at all.
describe("ScorePad — Clear score", () => {
  it("shows a Clear score button when the cell currently holds a result", () => {
    const current: HoleResult = { kind: "strokes", strokes: 5 };
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} current={current} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Clear score" })).toBeTruthy();
  });

  it("an unscored cell's pad (no current result) has no Clear score button", () => {
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Clear score" })).toBeNull();
  });

  it("tapping Clear score posts { kind: 'cleared' }", () => {
    const onSubmit = vi.fn<(result: HoleResult) => void>();
    const current: HoleResult = { kind: "picked-up" };
    render(<ScorePad golfer={ANN} hole={HOLE_PAR4} current={current} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear score" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ kind: "cleared" });
  });
});
