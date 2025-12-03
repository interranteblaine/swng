import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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
  it("renders the home route without crashing", () => {
    renderWithProviders("/");
    // Simple, stable assertion based on HomeView content
    expect(
      screen.getByRole("link", { name: /create a round/i })
    ).toBeInTheDocument();
  });
});
