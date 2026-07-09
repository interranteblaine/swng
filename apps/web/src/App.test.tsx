import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the placeholder shell", () => {
    render(<App />);

    expect(screen.getByText("swng")).toBeTruthy();
  });
});
