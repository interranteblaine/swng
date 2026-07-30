import { describe, expect, it } from "vitest";
import type { Golfer } from "@swng/domain";
import { golferId, placeholderName } from "@swng/domain";
import { ApplicationError } from "../errors.js";
import type { GolferStore } from "../ports/golferStore.js";
import { createCapturingMetrics, createInMemoryGolferStore, createSequentialIds } from "../testing/fakes.js";
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

// Metrics port (prod-readiness Arc B task 1): a capturing sink threaded alongside the same
// golferStore/idGenerator pair, so these cases can assert exactly which branch emitted.
const setupMetrics = () => {
  const golferStore = createInMemoryGolferStore();
  const idGenerator = createSequentialIds("g");
  const metrics = createCapturingMetrics();
  return { golferStore, idGenerator, metrics, ensure: ensureGolfer({ golferStore, idGenerator, metrics }) };
};

describe("ensureGolfer", () => {
  it("mints a golfer with the deterministic placeholder name f(sub) and namePlaceholder: true when the sub has none", async () => {
    const { golferStore, ensure } = setup();

    const golfer = await ensure({ sub: "sub-1" });

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

  it("emits Signups once on a genuine first-touch create", async () => {
    const { ensure, metrics } = setupMetrics();

    await ensure({ sub: "sub-new" });

    expect(metrics.calls).toEqual(["Signups"]);
  });

  it("does NOT emit Signups when the golfer already exists", async () => {
    const { ensure, metrics } = setupMetrics();

    await ensure({ sub: "sub-a" }); // create
    await ensure({ sub: "sub-a" }); // second touch — existing branch

    expect(metrics.calls).toEqual(["Signups"]); // still one, from the first create
  });

  it("does NOT emit Signups on the race-loser path — bindSub throws golfer-already-claimed and the loser re-reads the winner", async () => {
    // The concurrent-first-request race (ensureGolfer.ts's own doc comment): getBySub misses
    // (nobody's minted yet), so this request `put`s a fresh row and calls bindSub — but another
    // request won the bind first, so bindSub throws golfer-already-claimed. The metric emit sits
    // between bindSub and its own catch (production code, unchanged here), so the loser must NOT
    // emit — only the winner's original bindSub call did that, on a different ensureGolfer
    // invocation entirely. This double stands in for that winner's already-bound row: the first
    // getBySub call (this request's own initial check) misses, the second (the loser's re-read
    // inside the catch) returns it.
    const winner: Golfer = { id: golferId("winner-1"), name: placeholderName("sub-race"), namePlaceholder: true };
    let getBySubCalls = 0;
    const golferStore: GolferStore = {
      getBySub: async () => {
        getBySubCalls += 1;
        return getBySubCalls === 1 ? undefined : { golfer: winner, sub: "sub-race", revision: 1 };
      },
      put: async () => {},
      get: async () => undefined,
      getMany: async () => [],
      bindSub: async () => {
        throw new ApplicationError("golfer-already-claimed");
      },
    };
    const idGenerator = createSequentialIds("g");
    const metrics = createCapturingMetrics();
    const ensure = ensureGolfer({ golferStore, idGenerator, metrics });

    const golfer = await ensure({ sub: "sub-race" });

    expect(golfer.id).toBe(winner.id);
    expect(metrics.calls).toEqual([]);
  });
});
