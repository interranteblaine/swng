import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@swng/adapters-dynamodb barrel", () => {
  it("identifies itself", () => {
    expect(packageName).toBe("@swng/adapters-dynamodb");
  });
});
