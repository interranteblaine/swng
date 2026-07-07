import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@swng/application barrel", () => {
  it("identifies itself", () => {
    expect(packageName).toBe("@swng/application");
  });
});
