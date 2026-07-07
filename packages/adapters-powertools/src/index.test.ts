import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@swng/adapters-powertools barrel", () => {
  it("identifies itself", () => {
    expect(packageName).toBe("@swng/adapters-powertools");
  });
});
