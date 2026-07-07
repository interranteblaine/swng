import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@swng/adapters-cognito barrel", () => {
  it("identifies itself", () => {
    expect(packageName).toBe("@swng/adapters-cognito");
  });
});
