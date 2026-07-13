import { describe, expect, it } from "vitest";
import { placeholderName } from "@swng/domain";
import { createInMemoryGolferStore, createSequentialIds } from "../testing/fakes.js";
import { ensureGolfer } from "./ensureGolfer.js";

// Get-or-create on first touch (accounts-only identity spec §2): the first authenticated request
// that needs the caller's golfer mints it, with a deterministic placeholder name f(sub) and
// namePlaceholder: true. A second ensure for the same sub returns that same golfer, never a
// second row. (The concurrent-first-request race — two parallel ensures against a real store —
// is pinned in adapters-dynamodb's golferStore contract suite, where a genuine transaction can
// arbitrate it.)
const setup = () => {
  const golferStore = createInMemoryGolferStore();
  const idGenerator = createSequentialIds("g");
  return { golferStore, ensure: ensureGolfer({ golferStore, idGenerator }) };
};

describe("ensureGolfer", () => {
  it("mints a golfer with the deterministic placeholder name f(sub) and namePlaceholder: true when the sub has none", async () => {
    const { golferStore, ensure } = setup();

    const golfer = await ensure({ sub: "sub-1", email: "ann@example.com" });

    expect(golfer.name).toBe(placeholderName("sub-1"));
    expect(golfer.namePlaceholder).toBe(true);
    // Cognito is a pure authenticator: the name is f(sub), never the email localpart.
    expect(golfer.name).not.toBe("ann");
    // The row is really bound to the sub now.
    expect((await golferStore.getBySub("sub-1"))?.golfer.id).toBe(golfer.id);
  });

  it("returns the same golfer on a second ensure — one golfer per account, never a second row", async () => {
    const { golferStore, ensure } = setup();

    const first = await ensure({ sub: "sub-1" });
    const second = await ensure({ sub: "sub-1" });

    expect(second.id).toBe(first.id);
    expect(second.namePlaceholder).toBe(true);
    // The second call read the existing row, it didn't mint a second one.
    expect((await golferStore.getBySub("sub-1"))?.golfer.id).toBe(first.id);
  });

  it("reads ONLY the sub from the claims — an email present or absent yields the identical f(sub) name", async () => {
    const withEmail = await setup().ensure({ sub: "sub-x", email: "someone@example.com" });
    const withoutEmail = await setup().ensure({ sub: "sub-x" });

    expect(withEmail.name).toBe(placeholderName("sub-x"));
    expect(withoutEmail.name).toBe(placeholderName("sub-x"));
  });
});
