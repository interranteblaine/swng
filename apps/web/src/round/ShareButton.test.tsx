import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { roundId } from "@swng/domain";
import { ShareButton } from "./ShareButton";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fakeResponse = (status: number, body: unknown): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe("ShareButton", () => {
  it("fetches the share link, resolves it against this device's own origin, and copies it", async () => {
    let seenUrl: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seenUrl = url;
        return fakeResponse(200, { url: "/watch/round-1#spectator-token" });
      }),
    );
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    render(<ShareButton roundId={roundId("round-1")} token="participant-token" />);

    fireEvent.click(screen.getByRole("button", { name: "Share round" }));

    await waitFor(() => expect(screen.getByText(/Link copied/)).toBeTruthy());
    expect(seenUrl).toContain("/rounds/round-1/share");
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/watch/round-1#spectator-token`);
    expect(screen.getByText(`${window.location.origin}/watch/round-1#spectator-token`)).toBeTruthy();
  });

  it("still shows the raw url as a visible fallback when clipboard access fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(200, { url: "/watch/round-1#spectator-token" })),
    );
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error("permission denied");
        }),
      },
    });

    render(<ShareButton roundId={roundId("round-1")} token="participant-token" />);
    fireEvent.click(screen.getByRole("button", { name: "Share round" }));

    await waitFor(() => expect(screen.getByText(/Copy this link/)).toBeTruthy());
    expect(screen.getByText(`${window.location.origin}/watch/round-1#spectator-token`)).toBeTruthy();
  });

  it("shows a fixed error line on a failed fetch, never the raw error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(403, { code: "read-only-token", message: "read-only-token" })),
    );

    render(<ShareButton roundId={roundId("round-1")} token="participant-token" />);
    fireEvent.click(screen.getByRole("button", { name: "Share round" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toBe("Could not create a share link — try again.");
  });
});
