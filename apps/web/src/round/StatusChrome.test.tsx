import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { deviceId, golferId, opId } from "@swng/domain";
import type { Participant, RoundEvent } from "@swng/domain";
import type { RejectedOp } from "@swng/client";
import { StatusChrome } from "./StatusChrome";

const ANN = golferId("ann");
const participants: readonly Participant[] = [{ golferId: ANN, name: "Ann", tee: "white", courseHandicap: 8 }];

const scoreRecorded = (hole: number): RoundEvent => ({
  kind: "score-recorded",
  golferId: ANN,
  hole,
  result: { kind: "strokes", strokes: 5 },
  authorId: ANN,
  opId: opId(`op-${hole}`),
  hlc: { wallMs: 1, counter: 0, deviceId: deviceId("d") },
});

const rejectedOp = (hole: number, code: string): RejectedOp => ({ event: scoreRecorded(hole), code });

afterEach(() => cleanup());

describe("StatusChrome — offline banner", () => {
  it("shows a calm offline banner when !connected, naming the queue as a feature", () => {
    render(<StatusChrome connected={false} pending={0} rejected={[]} participants={participants} />);

    const banner = screen.getByRole("status");
    expect(banner.textContent).toMatch(/offline/i);
    expect(banner.textContent).toMatch(/queue/i); // "the queue IS the feature" — brief's tone
  });

  it("shows no banner when connected", () => {
    render(<StatusChrome connected={true} pending={0} rejected={[]} participants={participants} />);

    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("StatusChrome — pending badge", () => {
  it("shows the pending count and nothing when it's zero", () => {
    const { rerender } = render(<StatusChrome connected={true} pending={3} rejected={[]} participants={participants} />);
    expect(screen.getByText(/3/)).toBeTruthy();

    rerender(<StatusChrome connected={true} pending={0} rejected={[]} participants={participants} />);
    expect(screen.queryByText(/syncing/i)).toBeNull();
  });
});

describe("StatusChrome — rejected ops", () => {
  it("surfaces a rejected op as a dismissible toast and a persistent row naming golfer/hole/code", () => {
    const rejected = [rejectedOp(7, "round-finalized")];
    render(<StatusChrome connected={true} pending={0} rejected={rejected} participants={participants} />);

    // Toast (dismissible summary) + a named row both mention the failure.
    expect(screen.getByRole("alert")).toBeTruthy();
    const row = screen.getByText(/Ann/).closest("li");
    expect(row?.textContent).toMatch(/hole 7/i);
    expect(row?.textContent).toMatch(/round-finalized/);
  });

  it("dismissing the toast hides it but the row survives", () => {
    const rejected = [rejectedOp(9, "some-error")];
    render(<StatusChrome connected={true} pending={0} rejected={rejected} participants={participants} />);

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/hole 9/i)).toBeTruthy(); // the row is still there
  });

  it("a fresh rejection re-surfaces the toast even after a prior one was dismissed", () => {
    const first = [rejectedOp(1, "err-1")];
    const { rerender } = render(<StatusChrome connected={true} pending={0} rejected={first} participants={participants} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("alert")).toBeNull();

    const second = [...first, rejectedOp(2, "err-2")];
    rerender(<StatusChrome connected={true} pending={0} rejected={second} participants={participants} />);

    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
