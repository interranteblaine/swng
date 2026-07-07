import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@swng/contracts barrel", () => {
  it("identifies itself", () => {
    expect(packageName).toBe("@swng/contracts");
  });
});
