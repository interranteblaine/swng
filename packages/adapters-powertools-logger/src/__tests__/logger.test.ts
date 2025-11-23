import { describe, it, expect, vi, beforeEach } from "vitest";
import { PowertoolsLoggerAdapter } from "../index";
import type { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";

function createMockPowertools() {
  const info = vi.fn();
  const error = vi.fn();
  const warn = vi.fn();
  const debug = vi.fn();

  const instance = { info, error, warn, debug } as unknown as PowertoolsLogger;

  return { instance, mocks: { info, error, warn, debug } };
}

describe("PowertoolsLoggerAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const levels = ["info", "error", "warn", "debug"] as const;

  for (const level of levels) {
    it(`forwards ${level} with message only when context is undefined`, () => {
      const { instance, mocks } = createMockPowertools();
      const adapter = new PowertoolsLoggerAdapter(instance);

      adapter[level]("hello");

      const fn = mocks[level];
      expect(fn).toHaveBeenCalledTimes(1);
      // Ensure only one arg was passed (message)
      expect(fn.mock.calls[0]).toEqual(["hello"]);
    });

    it(`forwards ${level} with message and context when provided`, () => {
      const { instance, mocks } = createMockPowertools();
      const adapter = new PowertoolsLoggerAdapter(instance);
      const ctx: Record<string, unknown> = { a: 1, b: "two" };

      adapter[level]("hello", ctx);

      const fn = mocks[level];
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith("hello", ctx);
    });
  }
});
