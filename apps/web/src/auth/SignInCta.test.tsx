import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { SignInCta } from "./SignInCta";
import { AuthProvider } from "./useAuth";

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderCta = (returnTo?: string) =>
  render(
    <AuthProvider>
      <SignInCta message="Sign in to join this round." returnTo={returnTo} />
    </AuthProvider>,
  );

describe("SignInCta", () => {
  it("renders its framing message and a Sign in button", () => {
    renderCta();
    expect(screen.getByText("Sign in to join this round.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("with a returnTo: stashes it in sessionStorage before redirecting to the Hosted UI", async () => {
    renderCta("/join?code=ABC123");

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // Stashed synchronously, before the (async, crypto-backed) redirect completes — the callback
    // reads it back on return so the code survives the round trip.
    expect(sessionStorage.getItem("swng:returnTo")).toBe("/join?code=ABC123");
    await waitFor(() => expect(new URL(window.location.href).pathname).toBe("/oauth2/authorize"));
  });

  it("with no returnTo: redirects without stashing anything (a plain sign-in falls back to home)", async () => {
    renderCta();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(sessionStorage.getItem("swng:returnTo")).toBeNull();
    await waitFor(() => expect(new URL(window.location.href).pathname).toBe("/oauth2/authorize"));
  });
});
