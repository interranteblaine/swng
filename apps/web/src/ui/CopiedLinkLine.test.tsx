import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CopiedLinkLine } from "./CopiedLinkLine";

afterEach(cleanup);

const LONG_URL = "https://beta.swng.golf/watch/98fc2344-9e29-411d-b27b-e076306a891d#eyJhbGciOiJIUzI1NiJ9.aVeryLongUnbrokenTokenFragment";

describe("CopiedLinkLine", () => {
  it("leads with 'Link copied' when the clipboard write succeeded, and shows the url", () => {
    render(<CopiedLinkLine url={LONG_URL} copied />);
    expect(screen.getByText(/Link copied —/)).toBeTruthy();
    expect(screen.getByText(LONG_URL)).toBeTruthy();
  });

  it("leads with 'Copy this link' when the clipboard write failed — the visible fallback", () => {
    render(<CopiedLinkLine url={LONG_URL} copied={false} />);
    expect(screen.getByText(/Copy this link —/)).toBeTruthy();
    expect(screen.getByText(LONG_URL)).toBeTruthy();
  });

  it("wraps the url instead of overflowing — break-all on the one unbroken token (owner field report, 2026-07-21)", () => {
    render(<CopiedLinkLine url={LONG_URL} copied />);
    // Class-name assertion, the touch-target precedent: happy-dom computes no real layout, so
    // the wrap contract is pinned on the class that implements it.
    expect(screen.getByText(LONG_URL).className).toContain("break-all");
    expect(screen.getByText(LONG_URL).className).toContain("select-all");
  });

  it("sets an optional note off before the url's em-dash, url intact", () => {
    render(<CopiedLinkLine url={LONG_URL} copied note="good for 7 days" />);
    expect(screen.getByText(/Link copied · good for 7 days/)).toBeTruthy();
    expect(screen.getByText(LONG_URL)).toBeTruthy();
    expect(screen.getByText(LONG_URL).className).toContain("break-all");
  });

  it("omits the note entirely when none is passed — the existing callers render unchanged", () => {
    render(<CopiedLinkLine url={LONG_URL} copied={false} />);
    expect(screen.getByText(/Copy this link —/)).toBeTruthy();
    expect(screen.queryByText(/·/)).toBeNull();
  });
});
