import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@swng/client barrel", () => {
  it("identifies itself", () => {
    expect(packageName).toBe("@swng/client");
  });
});
