import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";

function renderWithProviders() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  );
}

describe("App smoke test", () => {
  it("renders the home route without crashing", () => {
    renderWithProviders();
    // Simple, stable assertion based on HomeView content
    expect(screen.getByText(/create a round/i)).toBeInTheDocument();
  });
});
