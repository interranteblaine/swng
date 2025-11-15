import { describe, it, expect } from "vitest";
import { greet, type GreetOptions } from "../index";

describe("greet", () => {
  it("returns a casual greeting by default", () => {
    const options: GreetOptions = { name: "Alice" };

    const result = greet(options);

    expect(result).toBe("Hey Alice!");
  });

  it("returns a polite greeting when polite is true", () => {
    const options: GreetOptions = { name: "Bob", polite: true };

    const result = greet(options);

    expect(result).toBe("Hello, Bob.");
  });
});
