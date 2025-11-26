import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

describe("App", () => {
  it("renders heading", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { level: 1, name: /vite \+ react/i })
    ).toBeInTheDocument();
  });

  it("increments the counter when clicking the button", async () => {
    render(<App />);
    const user = userEvent.setup();
    const btn = screen.getByRole("button", { name: /count is/i });
    expect(btn).toBeInTheDocument();

    await user.click(btn);
    expect(btn).toHaveTextContent(/count is 1/i);

    await user.click(btn);
    expect(btn).toHaveTextContent(/count is 2/i);
  });
});
