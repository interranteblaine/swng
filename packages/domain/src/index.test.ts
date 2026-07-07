import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@swng/domain barrel", () => {
  it("identifies itself", () => {
    expect(packageName).toBe("@swng/domain");
  });
});
