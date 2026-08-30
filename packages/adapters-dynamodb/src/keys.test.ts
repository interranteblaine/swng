import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { evtSk, MAX_OAUTH_ID_BYTES, oauthClientPk, oauthCodePk, oauthHandlePk, oauthRequestPk } from "./keys.js";

describe("evtSk", () => {
  it("pads seq to 10 digits", () => {
    expect(evtSk(7)).toBe("EVT#0000000007");
  });

  it("orders lexically exactly as it orders numerically", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9_999_999_999 }),
        fc.integer({ min: 0, max: 9_999_999_999 }),
        (a, b) => {
          expect(evtSk(a) < evtSk(b)).toBe(a < b);
        },
      ),
    );
  });
});

describe("MAX_OAUTH_ID_BYTES", () => {
  // The budget the lambda's OAuth request schemas are written against. It is the ONE number that
  // cannot be checked by the endpoints' own tests: their fakes measure ids against this same
  // constant, so if it were wrong both sides would move together and agree. Derived here from the
  // key builders THEMSELVES (`build("")` is the prefix), independently of the constant's own
  // arithmetic — swng-speaks-mcp review round 2, N-1.
  const DYNAMO_PARTITION_KEY_MAX_BYTES = 2048;

  it("leaves room for the LONGEST key prefix under DynamoDB's 2048-byte partition-key ceiling", () => {
    const longestPrefixBytes = Math.max(
      ...[oauthClientPk, oauthRequestPk, oauthCodePk, oauthHandlePk].map((build) => Buffer.byteLength(build(""), "utf8")),
    );
    expect(MAX_OAUTH_ID_BYTES + longestPrefixBytes).toBe(DYNAMO_PARTITION_KEY_MAX_BYTES);
  });

  it("is the exact edge: an id at the budget builds a legal key in every slot, one byte more does not", () => {
    const atBudget = "a".repeat(MAX_OAUTH_ID_BYTES);
    const overBudget = "a".repeat(MAX_OAUTH_ID_BYTES + 1);
    for (const build of [oauthClientPk, oauthRequestPk, oauthCodePk, oauthHandlePk]) {
      expect(Buffer.byteLength(build(atBudget), "utf8")).toBeLessThanOrEqual(DYNAMO_PARTITION_KEY_MAX_BYTES);
    }
    // The longest slot is the one the budget is cut for, so it is the one that must overflow.
    expect(Buffer.byteLength(oauthRequestPk(overBudget), "utf8")).toBeGreaterThan(DYNAMO_PARTITION_KEY_MAX_BYTES);
  });
});
