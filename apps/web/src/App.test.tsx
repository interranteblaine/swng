import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "./testSupport/memoryStorage";
import { App } from "./App";

// Home/Create/Join/RoundPage each carry their own full behavior-contract test suite — this
// is just a smoke test that App.tsx's router wiring lands on Home at "/" (happy-dom's default
// window.location), not a re-test of any page's own behavior.
describe("App", () => {
  it("renders Home at the root route", () => {
    vi.stubGlobal("localStorage", createMemoryStorage());

    render(<App />);

    expect(screen.getByRole("link", { name: "Start a round" })).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
