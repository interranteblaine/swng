import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { golferId, roundId } from "@swng/domain";
import { credentialStore } from "../identity";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { HomePage } from "./HomePage";

// vitest.config.ts doesn't set test.globals, so @testing-library/react's own auto-cleanup
// (which only fires when it finds a GLOBAL `afterEach`) never registers — every spec file in
// this app that calls render() more than once must clean up explicitly, or one test's DOM
// (and localStorage stub) bleeds into the next.
beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderHome = () =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <HomePage />
    </MemoryRouter>,
  );

describe("HomePage", () => {
  it("links Start a round to /create", () => {
    renderHome();

    const link = screen.getByRole("link", { name: "Start a round" });
    expect(link.getAttribute("href")).toBe("/create");
  });

  it("links Join by code to /join", () => {
    renderHome();

    const link = screen.getByRole("link", { name: "Join by code" });
    expect(link.getAttribute("href")).toBe("/join");
  });

  it("lists saved rounds from credentialStore.list(), each linking to /round/:id", () => {
    credentialStore.save(roundId("round-1"), { token: "t1", golferId: golferId("ann"), name: "Ann", joinCode: "AAA111" });
    credentialStore.save(roundId("round-2"), { token: "t2", golferId: golferId("bo"), name: "Bo", joinCode: "BBB222" });

    renderHome();

    const annLink = screen.getByRole("link", { name: "Ann" });
    const boLink = screen.getByRole("link", { name: "Bo" });
    expect(annLink.getAttribute("href")).toBe("/round/round-1");
    expect(boLink.getAttribute("href")).toBe("/round/round-2");
  });

  it("shows an empty state when no rounds are saved", () => {
    renderHome();

    expect(screen.getByText(/no rounds yet/i)).toBeTruthy();
  });
});
