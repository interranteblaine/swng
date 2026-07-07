import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@swng/lambda barrel", () => {
  it("identifies itself", () => {
    expect(packageName).toBe("@swng/lambda");
  });
});
