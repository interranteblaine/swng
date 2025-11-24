import { describe, it, expect } from "vitest";
import { ApplicationError, type Logger } from "@swng/application";
import {
  toHttpErrorResponse,
  requireSessionId,
} from "../lambda-http-handler/httpUtils";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  with: () => noopLogger,
};

describe("http utils behavior", () => {
  it("toHttpErrorResponse maps ApplicationError to proper status/body", () => {
    const err = new ApplicationError("INVALID_INPUT", "bad");
    const res = toHttpErrorResponse(err, noopLogger);
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body || "{}");
    expect(body.error).toEqual({ code: "INVALID_INPUT", message: "bad" });
  });

  it("toHttpErrorResponse maps unknown Error to 500", () => {
    const err = new Error("boom");
    const res = toHttpErrorResponse(err, noopLogger);
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body || "{}");
    expect(body.error.code).toBe("INTERNAL");
  });

  it("requireSessionId returns the header value", () => {
    const value = requireSessionId({ "x-session-id": "sess_123" });
    expect(value).toBe("sess_123");
  });

  it("requireSessionId throws when header missing", () => {
    expect(() => requireSessionId({})).toThrowError(ApplicationError);
  });
});
