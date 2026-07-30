import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceId, golferId, opId } from "@swng/domain";
import type { Participant, RoundEvent } from "@swng/domain";
import type { RejectedOp } from "@swng/client";
import { StatusChrome } from "./StatusChrome";

const ANN = golferId("ann");
const participants: readonly Participant[] = [{ golferId: ANN, name: "Ann", tee: "white", basis: { kind: "normally-shoots", overPar: 8 } }];

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

const NOOP = () => {};

afterEach(() => cleanup());

describe("StatusChrome — offline banner", () => {
  it("shows a calm offline banner when !connected, naming the queue as a feature", () => {
    render(<StatusChrome connected={false} pending={0} rejected={[]} participants={participants} onReconnect={NOOP} />);

    const banner = screen.getByRole("status");
    expect(banner.textContent).toMatch(/offline/i);
    expect(banner.textContent).toMatch(/queue/i); // "the queue IS the feature" — brief's tone
  });

  it("shows no banner when connected", () => {
    render(<StatusChrome connected={true} pending={0} rejected={[]} participants={participants} onReconnect={NOOP} />);

    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("StatusChrome — reconnect affordance", () => {
  it("shows a 'Sync now' button beside the offline banner, and calls onReconnect when tapped", () => {
    const onReconnect = vi.fn();
    render(<StatusChrome connected={false} pending={0} rejected={[]} participants={participants} onReconnect={onReconnect} />);

    const button = screen.getByRole("button", { name: /sync now/i });
    fireEvent.click(button);

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("hides the reconnect button once connected — there's nothing to resume", () => {
    render(<StatusChrome connected={true} pending={0} rejected={[]} participants={participants} onReconnect={NOOP} />);

    expect(screen.queryByRole("button", { name: /sync now/i })).toBeNull();
  });
});

describe("StatusChrome — pending badge", () => {
  it("shows the pending count and nothing when it's zero", () => {
    const { rerender } = render(<StatusChrome connected={true} pending={3} rejected={[]} participants={participants} onReconnect={NOOP} />);
    expect(screen.getByText(/3/)).toBeTruthy();

    rerender(<StatusChrome connected={true} pending={0} rejected={[]} participants={participants} onReconnect={NOOP} />);
    expect(screen.queryByText(/syncing/i)).toBeNull();
  });
});

describe("StatusChrome — rejected ops", () => {
  it("surfaces a rejected op as a dismissible toast and a persistent row naming golfer/hole/code", () => {
    const rejected = [rejectedOp(7, "round-finalized")];
    render(<StatusChrome connected={true} pending={0} rejected={rejected} participants={participants} onReconnect={NOOP} />);

    // Toast (dismissible summary) + a named row both mention the failure.
    expect(screen.getByRole("alert")).toBeTruthy();
    const row = screen.getByText(/Ann/).closest("li");
    expect(row?.textContent).toMatch(/hole 7/i);
    expect(row?.textContent).toMatch(/round-finalized/);
  });

  it("dismissing the toast hides it but the row survives", () => {
    const rejected = [rejectedOp(9, "some-error")];
    render(<StatusChrome connected={true} pending={0} rejected={rejected} participants={participants} onReconnect={NOOP} />);

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/hole 9/i)).toBeTruthy(); // the row is still there
  });

  it("a fresh rejection re-surfaces the toast even after a prior one was dismissed", () => {
    const first = [rejectedOp(1, "err-1")];
    const { rerender } = render(<StatusChrome connected={true} pending={0} rejected={first} participants={participants} onReconnect={NOOP} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("alert")).toBeNull();

    const second = [...first, rejectedOp(2, "err-2")];
    rerender(<StatusChrome connected={true} pending={0} rejected={second} participants={participants} onReconnect={NOOP} />);

    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
