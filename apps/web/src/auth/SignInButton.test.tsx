import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { AuthProvider } from "./useAuth";
import { SignInButton } from "./SignInButton";

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SignInButton", () => {
  it("clicking it redirects to the Hosted UI's authorize endpoint", async () => {
    render(
      <AuthProvider>
        <SignInButton />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // computeCodeChallenge awaits a real crypto.subtle.digest — genuinely async, not just a
    // microtask — so this polls rather than assuming a fixed number of flushes.
    await waitFor(() => expect(new URL(window.location.href).pathname).toBe("/oauth2/authorize"));
  });
});
