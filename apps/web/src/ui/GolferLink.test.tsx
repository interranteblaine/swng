import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { golferId } from "@swng/domain";
import { GolferLink, PlainNamesContext } from "./GolferLink";

afterEach(() => cleanup());

describe("GolferLink", () => {
  it("renders an anchor to /golfers/:golferId wearing the golfer's name", () => {
    render(
      <MemoryRouter>
        <GolferLink golferId={golferId("g1")} name="Ann" />
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", { name: "Ann" });
    expect(link.getAttribute("href")).toBe("/golfers/g1");
  });

  // WatchPage's spectator tree turns every golfer link off at the root (spec §4c.2) — a context,
  // not a prop threaded through four component layers.
  it("inside PlainNamesContext.Provider value={true}, renders a plain span — NO anchor", () => {
    render(
      <MemoryRouter>
        <PlainNamesContext.Provider value={true}>
          <GolferLink golferId={golferId("g1")} name="Ann" />
        </PlainNamesContext.Provider>
      </MemoryRouter>,
    );

    expect(screen.getByText("Ann")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Ann" })).toBeNull();
  });
});
