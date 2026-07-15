import { describe, expect, it } from "vitest";
import { combineNineHoleDifferentials, computeIndexDetail, courseId, deviceId, fixtureLinks, golferId, opId, placeholderName, roundId } from "@swng/domain";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import { createFrozenClock, createInMemoryGolferStore, createInMemoryJournal, createInMemoryProjectionStore, createSequentialIds } from "../testing/fakes.js";
import { getMyGolfer } from "./getMyGolfer.js";
import { getMyLiveRounds } from "./getMyLiveRounds.js";
import { getMyRecord } from "./getMyRecord.js";
import { getMyRounds } from "./getMyRounds.js";
import { updateMyGolfer } from "./updateMyGolfer.js";

// getMyRecord's read-time index fold (pre-prod hardening D4a) needs a frozen clock so
// computedAtMs is a known, assertable value rather than a live Date.now() read.
const FROZEN_NOW = 9_999;

// Accounts-only identity (spec §1): there are no ghosts and nothing to claim, so this file's
// golfer surface is get-or-create (GET /me / PUT /me via ensureGolfer) plus the record/rounds
// reads — no claim machinery at all. A simple golferStore-backed setup covers all of it.
const setup = (golferStore: GolferStore = createInMemoryGolferStore()) => {
  const idGenerator = createSequentialIds("g");
  const projectionStore = createInMemoryProjectionStore();
  const journal = createInMemoryJournal();
  const clock = createFrozenClock(FROZEN_NOW);
  return {
    golferStore,
    projectionStore,
    journal,
    getMe: getMyGolfer({ golferStore, idGenerator }),
    updateMe: updateMyGolfer({ golferStore, idGenerator }),
    record: getMyRecord({ golferStore, projectionStore, clock }),
    myRounds: getMyRounds({ golferStore, projectionStore }),
    myLiveRounds: getMyLiveRounds({ golferStore, projectionStore, journal }),
  };
};

// GET /me get-or-creates (accounts-only identity spec §2, controller ruling — DELIBERATELY reverses
// the M7 "GET /me never creates" rule this block used to pin). That rule existed only to protect
// claimable ghosts (an auto-create bound the sub before a later claim could run); the spec kills
// ghosts, so the first authenticated GET /me now mints the caller's golfer.
describe("getMyGolfer — get-or-creates", () => {
  it("a fresh sub MINTS a golfer named f(sub) with namePlaceholder: true, and a second GET returns the SAME golfer", async () => {
    const ctx = setup();
    const first = await ctx.getMe({ sub: "sub-1", email: "ann@example.com" });
    expect(first.golfer).not.toBeNull();
    expect(first.golfer?.name).toBe(placeholderName("sub-1"));
    expect(first.golfer?.namePlaceholder).toBe(true);
    // Cognito is a pure authenticator — the name is f(sub), never the email localpart.
    expect(first.golfer?.name).not.toBe("ann");

    const second = await ctx.getMe({ sub: "sub-1", email: "ann@example.com" });
    expect(second.golfer?.golferId).toBe(first.golfer?.golferId);
    // Exactly one row, bound to the sub — the second GET read it, never minted a second.
    expect((await ctx.golferStore.getBySub("sub-1"))?.golfer.id).toBe(first.golfer?.golferId);
  });

  it("PUT /me then GET /me returns the same golferId", async () => {
    const ctx = setup();
    const created = await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});

    const found = await ctx.getMe({ sub: "sub-1" });

    expect(found.golfer?.golferId).toBe(created.golfer.golferId);
  });
});

// The placeholder is the invariant's backstop, not the UX (accounts-only identity spec §2): a real
// name via PUT /me drops the flag; a PUT that never touches the name preserves it.
describe("namePlaceholder lifecycle", () => {
  it("a real-name PUT /me DROPS the flag (absent = false, never rewritten to false), and it stays dropped on re-read", async () => {
    const ctx = setup();
    const minted = await ctx.getMe({ sub: "sub-1" });
    expect(minted.golfer?.namePlaceholder).toBe(true);

    const renamed = await ctx.updateMe({ sub: "sub-1" }, { name: "Annika" });
    expect(renamed.golfer.name).toBe("Annika");
    expect(renamed.golfer).not.toHaveProperty("namePlaceholder");

    const reread = await ctx.getMe({ sub: "sub-1" });
    expect(reread.golfer).not.toHaveProperty("namePlaceholder");
  });

  it("a PUT /me that leaves the name untouched (a declared-index-only edit) PRESERVES the flag", async () => {
    const ctx = setup();
    await ctx.getMe({ sub: "sub-1" }); // mint with the flag

    const patched = await ctx.updateMe({ sub: "sub-1" }, { declared: 12.0 });
    expect(patched.golfer.namePlaceholder).toBe(true);
    expect(patched.golfer.declared).toBe(12.0);
  });
});

describe("updateMyGolfer", () => {
  it("patches only the provided fields, leaving the rest as-is", async () => {
    const ctx = setup();
    // First PUT (empty patch) get-or-creates via ensureGolfer: the create name is the sub-derived
    // placeholder (Cognito is a pure authenticator — never the email localpart), flag preserved by
    // the declared-only patch.
    await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});

    const updated = await ctx.updateMe({ sub: "sub-1" }, { declared: 14.2 });
    expect(updated.golfer.name).toBe(placeholderName("sub-1")); // untouched — still the placeholder, never "ann"
    expect(updated.golfer.declared).toBe(14.2);

    const renamed = await ctx.updateMe({ sub: "sub-1" }, { name: "Annika" });
    expect(renamed.golfer.name).toBe("Annika");
    expect(renamed.golfer.declared).toBe(14.2); // untouched by the second patch
  });

  it("get-or-creates on the first PUT /me — one shared ensureGolfer path (GET /me get-or-creates too)", async () => {
    const ctx = setup();
    const updated = await ctx.updateMe({ sub: "sub-1", email: "bo@example.com" }, { declared: 9.1 });
    expect(updated.golfer.declared).toBe(9.1);
  });

  it("creates with the sub-derived placeholder name, NEVER the email localpart (Cognito is a pure authenticator)", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    expect(golfer.name).toBe(placeholderName("sub-1"));
    expect(golfer.name).not.toBe("ann");
    expect(golfer.namePlaceholder).toBe(true);
  });

  it("carries declared and official on the wire as independent fields — no derived effective/computed (the server has no persisted computed index to derive from; the web composes effectiveIndex itself from GET /me + GET /me/record)", async () => {
    const ctx = setup();
    await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    const declaredOnly = await ctx.updateMe({ sub: "sub-1" }, { declared: 14.2 });
    expect(declaredOnly.golfer.declared).toBe(14.2);
    expect(declaredOnly.golfer).not.toHaveProperty("effective");
    expect(declaredOnly.golfer).not.toHaveProperty("computed");

    const withOfficial = await ctx.updateMe({ sub: "sub-1" }, { official: 8.1 });
    expect(withOfficial.golfer.official).toBe(8.1);
    expect(withOfficial.golfer.declared).toBe(14.2); // still on record, unaffected by the official patch
    expect(withOfficial.golfer).not.toHaveProperty("effective");
  });
});

describe("getMyRecord", () => {
  it("returns an empty record for a sub with no golfer at all — no throw, no create", async () => {
    const ctx = setup();
    const record = await ctx.record({ sub: "sub-1" });
    expect(record).toEqual({ history: [] });
  });

  it("bootstrap not met: history present, index absent below 3 differentials", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      ags: 90,
      differential: 9.0,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    });

    const record = await ctx.record({ sub: "sub-1" });
    expect(record.index).toBeUndefined();
    expect(record.history).toHaveLength(1);
  });

  // courseId (course-cards spec §4, the analytics join key): carried when the stored line has
  // it, omitted for a pre-scrap line without it — absent means ABSENT, never an explicit
  // undefined key (toWireLine's conditional-spread idiom, same as ags/differential).
  it("carries courseId on a history line when the stored line has it, omitting it for a line without", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      courseId: courseId("course-1"),
      tee: "white",
      holes: 18,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 2_000,
    });
    // A pre-scrap line: no courseId at all (frozen before cards carried a source).
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r0"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    });

    const record = await ctx.record({ sub: "sub-1" });
    expect(record.history.map((line) => line.roundId)).toEqual(["r1", "r0"]); // newest first
    expect(record.history[0]!.courseId).toBe(courseId("course-1"));
    expect(record.history[1]).not.toHaveProperty("courseId");
  });

  // Below the 3-differential bootstrap (Rule 5.2a's own minimum), the index is ABSENT, not
  // zero — computeIndexDetail itself returns undefined under 3 (whs.ts), and getMyRecord
  // must pass that absence straight through, never coercing it into a 0 the wire schema
  // could mistake for a real (if unlikely) index value.
  it("below the 3-differential bootstrap the index is ABSENT, not zero", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1", email: "bo@example.com" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      ags: 90,
      differential: 9.0,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    });
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r2"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      ags: 95,
      differential: 14.0,
      distribution: { eagles: 0, birdies: 0, pars: 5, bogeys: 13, doublePlus: 0 },
      finalizedAtMs: 2_000,
    });

    const record = await ctx.record({ sub: "sub-1" });
    expect(record.index).toBeUndefined();
    expect(record.history).toHaveLength(2);
  });

  // The pre-prod hardening headline pin (D4a): the index is computed HERE, at read time, from
  // the SAME lines this response already carries — never a stored snapshot (no putIndex call
  // anywhere in this test). The oracle is the identical domain fold projectArchive used to run
  // (sortLines -> combineNineHoleDifferentials -> computeIndexDetail), proving getMyRecord's
  // wire index agrees with it byte-for-byte, with computedAtMs pinned to this setup's frozen
  // clock rather than a live wall-clock read.
  it("computes the index at read time from the history lines — no stored snapshot is consulted", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    const seededCompleteLines = [
      { roundId: roundId("r1"), ags: 90, differential: 9.0, finalizedAtMs: 1_000 },
      { roundId: roundId("r2"), ags: 95, differential: 14.0, finalizedAtMs: 2_000 },
      { roundId: roundId("r3"), ags: 92, differential: 11.0, finalizedAtMs: 3_000 },
    ];
    for (const line of seededCompleteLines) {
      await ctx.projectionStore.putLine(golfer.golferId, {
        roundId: line.roundId,
        courseName: "Casa Verde GC",
        tee: "white",
        holes: 18,
        ags: line.ags,
        differential: line.differential,
        distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
        finalizedAtMs: line.finalizedAtMs,
      });
    }

    const response = await ctx.record({ sub: "sub-1" });

    const expected = computeIndexDetail(combineNineHoleDifferentials(seededCompleteLines.map((l) => ({ differential: l.differential, holes: 18 }))))!;
    expect(response.index).toEqual({ value: expected.value, computedAtMs: FROZEN_NOW, differentialsUsed: expected.differentialsUsed });
    expect(response.history.map((line) => line.roundId)).toEqual(["r3", "r2", "r1"]); // newest first
  });

  // ProjectionStore.listLines is UNORDERED by contract (ports/projectionStore.ts) — the stable
  // ROUND# sk carries no time to sort by. This proves getMyRecord itself imposes the
  // (finalizedAtMs, roundId) order BEFORE the index fold (the fold moved here from the
  // projector with D4a — this pin replaces projectArchive's own former version of the same
  // proof), via a fake store whose listLines returns lines in the OPPOSITE order from how they
  // were logically produced. combineNineHoleDifferentials pairs ADJACENT entries positionally
  // (its own doc comment) — feeding it unsorted mispairs everyone, not just reorders the same
  // pairs: 7 nine-hole lines, chronological r1..r7, sorted ascending pairs (r1,r2)=1+2=3,
  // (r3,r4)=3+4=7, (r5,r6)=5+6=11, r7 pending → combined=[3,7,11]. A wrong implementation that
  // skips the sort would fold the REVERSED feed into a DIFFERENT value entirely, not just a
  // reordering of the same one.
  it("sorts lines by finalizedAtMs before folding — an out-of-order store never mispairs 9-hole differentials", async () => {
    const nineHoleLine = (id: string, finalizedAtMs: number, differential: number) => ({
      roundId: roundId(id),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 9 as const,
      differential,
      distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
      finalizedAtMs,
    });
    const chronological = [
      nineHoleLine("r1", 1_000, 1),
      nineHoleLine("r2", 2_000, 2),
      nineHoleLine("r3", 3_000, 3),
      nineHoleLine("r4", 4_000, 4),
      nineHoleLine("r5", 5_000, 5),
      nineHoleLine("r6", 6_000, 6),
      nineHoleLine("r7", 7_000, 7),
    ];
    const reversed = [...chronological].reverse();
    const outOfOrderStore: ProjectionStore = {
      putLine: async () => {},
      listLines: async () => reversed,
      putLive: async () => {},
      deleteLive: async () => {},
      listLive: async () => [],
    };
    const golferStore = createInMemoryGolferStore();
    await golferStore.put({ id: golferId("ann"), name: "Ann", handicap: {} }, undefined);
    await golferStore.bindSub(golferId("ann"), "sub-ann");
    const record = getMyRecord({ golferStore, projectionStore: outOfOrderStore, clock: createFrozenClock(FROZEN_NOW) });

    const response = await record({ sub: "sub-ann" });

    const expected = computeIndexDetail(combineNineHoleDifferentials([3, 7, 11].map((differential) => ({ differential, holes: 18 }))))!;
    expect(response.index).toEqual({ value: expected.value, computedAtMs: FROZEN_NOW, differentialsUsed: expected.differentialsUsed });
  });
});

// GET /me/rounds (projection-realignment Task 6): "list my rounds" — same golferStore/
// projectionStore setup as getMyRecord above, since myRounds shares its exact
// get-or-nothing + sortLines-then-reverse discipline (getMyRounds.ts's own doc comment).
describe("getMyRounds", () => {
  it("returns an empty list for a sub with no golfer row at all — no throw, no create", async () => {
    const ctx = setup();
    expect(await ctx.myRounds({ sub: "sub-1" })).toEqual({ rounds: [] });
  });

  it("lists every finalized round newest-first, each line carrying finalizedAt (the wire name for the store's finalizedAtMs)", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      ags: 90,
      differential: 9.0,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    });
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r2"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      ags: 95,
      differential: 14.0,
      distribution: { eagles: 0, birdies: 0, pars: 5, bogeys: 13, doublePlus: 0 },
      finalizedAtMs: 2_000,
    });

    const result = await ctx.myRounds({ sub: "sub-1" });
    expect(result.rounds.map((line) => line.roundId)).toEqual(["r2", "r1"]); // newest first
    expect(result.rounds.map((line) => line.finalizedAt)).toEqual([2_000, 1_000]);
    // Never the store's own internal field name leaking onto the wire.
    expect(result.rounds.every((line) => !("finalizedAtMs" in line))).toBe(true);
  });

  // createdAt (accounts-only identity spec §5, the "course + date" designation): carried when the
  // line has it, omitted for legacy lines written before the field existed (tolerated, no migration).
  it("carries createdAt (the round-created wall time) when the line has it, omitting it for a legacy line", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 2_000,
      createdAtMs: 1_500,
    });
    // A legacy line: no createdAtMs at all (an older projection write).
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r0"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    });

    const result = await ctx.myRounds({ sub: "sub-1" });
    expect(result.rounds.map((line) => line.roundId)).toEqual(["r1", "r0"]); // newest first
    expect(result.rounds[0]!.createdAt).toBe(1_500);
    expect(result.rounds[1]).not.toHaveProperty("createdAt");
  });

  // courseId (course-cards spec §4, the analytics join key): same carried-or-ABSENT discipline
  // as getMyRecord's history above — never an explicit undefined key on the wire.
  it("carries courseId when the stored line has it, omitting it for a pre-scrap line without", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      courseId: courseId("course-1"),
      tee: "white",
      holes: 18,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 2_000,
    });
    // A pre-scrap line: no courseId at all (frozen before cards carried a source).
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r0"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    });

    const result = await ctx.myRounds({ sub: "sub-1" });
    expect(result.rounds.map((line) => line.roundId)).toEqual(["r1", "r0"]); // newest first
    expect(result.rounds[0]!.courseId).toBe(courseId("course-1"));
    expect(result.rounds[1]).not.toHaveProperty("courseId");
  });

  // Same ordering the sibling getMyRecord assertion above pins — the two responses must never
  // silently disagree on "what order is my history in" (both go through sortLines).
  it("orders identically to GET /me/record's own history for the same golfer", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      ags: 90,
      differential: 9.0,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    });
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r2"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      ags: 95,
      differential: 14.0,
      distribution: { eagles: 0, birdies: 0, pars: 5, bogeys: 13, doublePlus: 0 },
      finalizedAtMs: 2_000,
    });

    const record = await ctx.record({ sub: "sub-1" });
    const rounds = await ctx.myRounds({ sub: "sub-1" });
    expect(rounds.rounds.map((line) => line.roundId)).toEqual(record.history.map((line) => line.roundId));
  });
});

// GET /me/rounds/live (projection-realignment Task 13): "your rounds, right now" — presence,
// not finalized history (getMyRounds above). Same get-or-nothing discipline; the store is
// exercised directly via putLive (not through startRound/joinRound — those are covered in
// rounds/roundSlice.test.ts's own presence suite) since this file's setup has no round
// journal at all.
describe("getMyLiveRounds", () => {
  it("returns an empty list for a sub with no golfer row at all — no throw, no create", async () => {
    const ctx = setup();
    expect(await ctx.myLiveRounds({ sub: "sub-1" })).toEqual({ rounds: [] });
  });

  it("returns an empty list for a real golfer with no live rounds", async () => {
    const ctx = setup();
    await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    expect(await ctx.myLiveRounds({ sub: "sub-1" })).toEqual({ rounds: [] });
  });

  it("lists live rounds newest-joined first, each carrying courseName + joinedAt (the wire name for joinedAtMs)", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    await ctx.projectionStore.putLive(golfer.golferId, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 1_000, expiresAtSec: 9_999_999_999 });
    await ctx.projectionStore.putLive(golfer.golferId, { roundId: roundId("r2"), courseName: "Pebble Municipal", joinedAtMs: 2_000, expiresAtSec: 9_999_999_999 });

    const result = await ctx.myLiveRounds({ sub: "sub-1" });
    expect(result.rounds).toEqual([
      { roundId: roundId("r2"), courseName: "Pebble Municipal", joinedAt: 2_000 },
      { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAt: 1_000 },
    ]);
    // Never the store's own internal field name leaking onto the wire.
    expect(result.rounds.every((entry) => !("joinedAtMs" in entry))).toBe(true);
  });

  // createdAt (accounts-only identity spec §5): derived at read time from the round's genesis, a
  // round-level fact — carried when the round exists, omitted for a stale pointer (the 36h TTL
  // backstop outliving a vanished round).
  it("carries createdAt derived from the round's genesis, omitting it for a stale pointer with no round behind it", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    // A real live round's genesis on the journal (wall time 7_777).
    await ctx.journal.append(roundId("r1"), [
      { kind: "round-created", roundId: roundId("r1"), card: fixtureLinks, opId: opId("g1"), hlc: { wallMs: 7_777, counter: 0, deviceId: deviceId("test") }, authorId: golferId("author") },
    ]);
    await ctx.projectionStore.putLive(golfer.golferId, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 1_000, expiresAtSec: 9_999_999_999 });
    // A stale presence pointer whose round never existed / has vanished.
    await ctx.projectionStore.putLive(golfer.golferId, { roundId: roundId("r2"), courseName: "Ghost Course", joinedAtMs: 2_000, expiresAtSec: 9_999_999_999 });

    const result = await ctx.myLiveRounds({ sub: "sub-1" });
    const r1 = result.rounds.find((entry) => entry.roundId === roundId("r1"))!;
    const r2 = result.rounds.find((entry) => entry.roundId === roundId("r2"))!;
    expect(r1.createdAt).toBe(7_777);
    expect(r2).not.toHaveProperty("createdAt");
  });
});
