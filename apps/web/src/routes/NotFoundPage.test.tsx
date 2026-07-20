import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { NotFoundPage } from "./NotFoundPage";

afterEach(() => cleanup());

// Mirrors App.tsx's own route table shape (a known route + a `path="*"` catch-all LAST) rather
// than rendering NotFoundPage bare — the brief's own contract is "rendering an unknown path
// through the app's routes," proving the catch-all actually resolves to this page.
const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<div>home page</div>} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe("NotFoundPage", () => {
  it("an unknown path renders the not-found copy and a link home", () => {
    renderAt("/this/path/does/not/exist");

    expect(screen.getByText("This page doesn't exist.")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Back to swng" });
    expect(link.getAttribute("href")).toBe("/");
  });

  it("sets the page title to \"Not found · swng\"", () => {
    renderAt("/this/path/does/not/exist");

    expect(document.title).toBe("Not found · swng");
  });
});
