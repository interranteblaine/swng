import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConsoleLogger } from "./compositionRoot.js";

// Pin for the M3-deferred fix (task-6-brief.md item 5): consoleLogger used to spread `data`
// AFTER `message` in the logged object, so a `data.message` key silently clobbered the
// actual log message. Message must always win.
describe("createConsoleLogger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("info: a data.message key never clobbers the real log message", () => {
    const logger = createConsoleLogger();
    logger.info("the real message", { message: "an attacker-controlled or coincidental data.message", roundId: "r-1" });

    const logged = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(logged).toEqual({ level: "info", roundId: "r-1", message: "the real message" });
  });

  it("error: a data.message key never clobbers the real log message", () => {
    const logger = createConsoleLogger();
    logger.error("the real error message", { message: "coincidental data.message" });

    const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string);
    expect(logged).toEqual({ level: "error", message: "the real error message" });
  });
});
