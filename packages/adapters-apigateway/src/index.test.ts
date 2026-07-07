import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@swng/adapters-apigateway barrel", () => {
  it("identifies itself", () => {
    expect(packageName).toBe("@swng/adapters-apigateway");
  });
});
