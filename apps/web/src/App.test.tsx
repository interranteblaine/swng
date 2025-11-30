import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import App from "./App";

function renderWithProviders(route: string = "/") {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("App smoke test", () => {
  it("renders nav links", () => {
    renderWithProviders("/");
    const nav = screen.getByRole("navigation");
    expect(
      within(nav).getByRole("link", { name: /^home$/i })
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: /^create$/i })
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: /^join$/i })
    ).toBeInTheDocument();
  });

  it("renders HomePage by default route", () => {
    renderWithProviders("/");
    expect(
      screen.getByRole("heading", { level: 1, name: /round manager/i })
    ).toBeInTheDocument();
  });
});
