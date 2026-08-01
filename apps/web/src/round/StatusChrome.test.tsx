import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceId, golferId, opId } from "@swng/domain";
import type { Participant, RoundEvent } from "@swng/domain";
import type { RejectedOp } from "@swng/client";
import { StatusChrome } from "./StatusChrome";

const ANN = golferId("ann");
const participants: readonly Participant[] = [{ golferId: ANN, name: "Ann", tee: "white", strokes: 0 }];

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

describe("StatusChrome — the queue is the subject", () => {
  it("names the queue, and where the scores are, while it drains", () => {
    render(<StatusChrome stalled={false} pending={2} rejected={[]} participants={participants} onReconnect={NOOP} />);

    expect(screen.getByRole("status").textContent).toContain("2 scores saved on this phone — syncing…");
    expect(screen.queryByRole("button", { name: "Try now" })).toBeNull();
  });

  it("says nothing at all when there is nothing queued and nothing wrong", () => {
    render(<StatusChrome stalled={false} pending={0} rejected={[]} participants={participants} onReconnect={NOOP} />);

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("escalates only once stalled, and keeps a manual retry there as a backstop", () => {
    const onReconnect = vi.fn();
    render(<StatusChrome stalled pending={2} rejected={[]} participants={participants} onReconnect={onReconnect} />);

    expect(screen.getByRole("status").textContent).toContain("Can't reach swng — your scores are safe here.");
    fireEvent.click(screen.getByRole("button", { name: "Try now" }));

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});

describe("StatusChrome — rejected ops", () => {
  it("surfaces a rejected op as a dismissible toast and a persistent row naming golfer/hole/code", () => {
    const rejected = [rejectedOp(7, "round-finalized")];
    render(<StatusChrome stalled={false} pending={0} rejected={rejected} participants={participants} onReconnect={NOOP} />);

    // Toast (dismissible summary) + a named row both mention the failure.
    expect(screen.getByRole("alert")).toBeTruthy();
    const row = screen.getByText(/Ann/).closest("li");
    expect(row?.textContent).toMatch(/hole 7/i);
    expect(row?.textContent).toMatch(/round-finalized/);
  });

  it("dismissing the toast hides it but the row survives", () => {
    const rejected = [rejectedOp(9, "some-error")];
    render(<StatusChrome stalled={false} pending={0} rejected={rejected} participants={participants} onReconnect={NOOP} />);

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/hole 9/i)).toBeTruthy(); // the row is still there
  });

  it("a fresh rejection re-surfaces the toast even after a prior one was dismissed", () => {
    const first = [rejectedOp(1, "err-1")];
    const { rerender } = render(<StatusChrome stalled={false} pending={0} rejected={first} participants={participants} onReconnect={NOOP} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("alert")).toBeNull();

    const second = [...first, rejectedOp(2, "err-2")];
    rerender(<StatusChrome stalled={false} pending={0} rejected={second} participants={participants} onReconnect={NOOP} />);

    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
