import { describe, expect, it } from "vitest";
import { deviceId, gameId, golferId, opId, roundId } from "../ids.js";
import type { GolferId } from "../ids.js";
import type { CourseCard } from "../course/card.js";
import type { Hlc } from "./hlc.js";
import type { HoleResult } from "./holeResult.js";
import type { RoundEvent } from "./events.js";
import { cellAt, cellKey, grossForHoles, parForHoles, reduceRound } from "./state.js";
import type { ScoreCell } from "./state.js";

const card: CourseCard = {
  courseName: "Fixture Links",
  teeSets: [{ name: "white", rating: 35.8, slope: 128, holes: [
    { number: 1, par: 4, yardage: 380, strokeIndex: 5 },
    { number: 2, par: 4, yardage: 410, strokeIndex: 1 },
    { number: 3, par: 3, yardage: 165, strokeIndex: 9 },
  ] }],
};
const A = golferId("a");
const B = golferId("b");
const at = (wallMs: number, device = "d1", counter = 0): Hlc => ({ wallMs, counter, deviceId: deviceId(device) });
let op = 0;
const base = (wallMs: number, device?: string) => ({ opId: opId(`op-${op++}`), hlc: at(wallMs, device), authorId: A });

const genesis: RoundEvent = { ...base(1), kind: "round-created", roundId: roundId("r1"), card };
const joinA: RoundEvent = { ...base(2), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", strokes: 8 } };
const started: RoundEvent = { ...base(3), kind: "round-started" };

describe("reduceRound", () => {
  it("throws on a log without genesis", () => {
    expect(() => reduceRound([joinA])).toThrowError(/round-log-missing-genesis/);
  });

  it("walks the lifecycle: setup → live → final → live again on reopen", () => {
    expect(reduceRound([genesis]).status).toBe("setup");
    expect(reduceRound([genesis, started]).status).toBe("live");
    const final: RoundEvent = { ...base(4), kind: "round-finalized" };
    const reopened: RoundEvent = { ...base(5), kind: "round-reopened" };
    expect(reduceRound([genesis, started, final]).status).toBe("final");
    expect(reduceRound([genesis, started, final, reopened]).status).toBe("live");
  });

  it("resolves same-cell conflicts by hlc, not arrival order", () => {
    const early: RoundEvent = { ...base(10, "offline-phone"), kind: "score-recorded", golferId: A, hole: 1, result: { kind: "strokes", strokes: 6 } };
    const correction: RoundEvent = { ...base(20, "online-phone"), kind: "score-recorded", golferId: A, hole: 1, result: { kind: "strokes", strokes: 5 } };
    // The stale offline write ARRIVES LAST — the correction must still win.
    const state = reduceRound([genesis, joinA, started, correction, early]);
    expect(state.cells[cellKey(A, 1)]?.result).toEqual({ kind: "strokes", strokes: 5 });
  });

  it("a clear beats an older concurrent score in every arrival order", () => {
    // Two concurrent writes for the same (golfer, hole) from different devices: a strokes
    // write at t1, a clear strictly later at t2 — HLC-latest wins regardless of which
    // arrives (or was pushed) first, exactly like any other same-cell conflict above.
    const scored: RoundEvent = { ...base(10, "device-a"), kind: "score-recorded", golferId: A, hole: 1, result: { kind: "strokes", strokes: 5 } };
    const cleared: RoundEvent = { ...base(20, "device-b"), kind: "score-recorded", golferId: A, hole: 1, result: { kind: "cleared" } };
    const forward = reduceRound([genesis, joinA, started, scored, cleared]);
    const backward = reduceRound([genesis, joinA, started, cleared, scored]);
    // The fold RETAINS the cleared cell (no deletion — see state.ts's cellAt doc) ...
    expect(forward.cells[cellKey(A, 1)]?.result.kind).toBe("cleared");
    expect(backward.cells[cellKey(A, 1)]?.result.kind).toBe("cleared");
    // ... but cellAt, the one sanctioned reader, hides it as unscored either way.
    expect(cellAt(forward.cells, A, 1)).toBeUndefined();
    expect(cellAt(backward.cells, A, 1)).toBeUndefined();
  });

  it("ignores a verbatim duplicate (same opId)", () => {
    const score: RoundEvent = { ...base(10), kind: "score-recorded", golferId: A, hole: 2, result: { kind: "strokes", strokes: 4 } };
    const once = reduceRound([genesis, joinA, started, score]);
    const twice = reduceRound([genesis, joinA, started, score, score]);
    expect(twice).toEqual(once);
  });

  it("treats a participant re-join as a correcting write (tee fix wins by hlc)", () => {
    const fixedTee: RoundEvent = { ...base(9), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", strokes: 9 } };
    const state = reduceRound([genesis, joinA, fixedTee]);
    expect(state.participants).toHaveLength(1);
    expect(state.participants[0]?.strokes).toBe(9);
  });

  it("skips unknown event kinds (schema tolerance)", () => {
    const alien = { ...base(50), kind: "press-opened", gameId: gameId("g9") } as unknown as RoundEvent;
    expect(reduceRound([genesis, joinA, alien]).participants).toHaveLength(1);
  });

  it("converges on same-opId, same-hlc collisions with different payloads (arrival order must not matter)", () => {
    const collisionHlc = at(30, "device-x");
    const x: RoundEvent = { opId: opId("collide-1"), hlc: collisionHlc, authorId: A, kind: "score-recorded", golferId: A, hole: 1, result: { kind: "strokes", strokes: 4 } };
    const y: RoundEvent = { opId: opId("collide-1"), hlc: collisionHlc, authorId: A, kind: "score-recorded", golferId: A, hole: 1, result: { kind: "strokes", strokes: 7 } };
    const forward = reduceRound([genesis, joinA, started, x, y]);
    const backward = reduceRound([genesis, joinA, started, y, x]);
    expect(backward).toEqual(forward);
  });

  it("records picked-up as a first-class result", () => {
    const pu: RoundEvent = { ...base(11), kind: "score-recorded", golferId: A, hole: 1, result: { kind: "picked-up" } };
    const state = reduceRound([genesis, joinA, started, pu]);
    expect(state.cells[cellKey(A, 1)]?.result.kind).toBe("picked-up");
  });

  it("audits recordedBy as the WRITE AUTHOR, not the score's subject (score-for-anyone means they differ)", () => {
    const joinB: RoundEvent = { ...base(2), kind: "participant-joined", participant: { golferId: B, name: "Bea", tee: "white", strokes: 12 } };
    const aRecordsForB: RoundEvent = { opId: opId(`op-${op++}`), hlc: at(11), authorId: A, kind: "score-recorded", golferId: B, hole: 1, result: { kind: "strokes", strokes: 5 } };
    const state = reduceRound([genesis, joinA, joinB, started, aRecordsForB]);
    expect(state.cells[cellKey(B, 1)]?.recordedBy).toBe(A);
  });

  it("orders participants and games by join order (first-write hlc), not by the hlc of the winning correction", () => {
    const joinB: RoundEvent = { ...base(2), kind: "participant-joined", participant: { golferId: B, name: "Bea", tee: "white", strokes: 12 } };
    // A joins first, B joins second, then A's handicap is corrected much later.
    const correctA: RoundEvent = { ...base(100), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", strokes: 6 } };
    const state = reduceRound([genesis, joinA, joinB, correctA]);
    expect(state.participants.map((p) => p.golferId)).toEqual([A, B]);
    expect(state.participants[0]?.strokes).toBe(6);

    const gameG1: RoundEvent = { ...base(2), kind: "game-added", config: { kind: "stroke-play", id: gameId("g1"), scoring: "gross", players: [A, B] } };
    const gameG2: RoundEvent = { ...base(3), kind: "game-added", config: { kind: "stroke-play", id: gameId("g2"), scoring: "gross", players: [A, B] } };
    const correctG1: RoundEvent = { ...base(100), kind: "game-added", config: { kind: "stroke-play", id: gameId("g1"), scoring: "net", players: [A, B] } };
    const gameState = reduceRound([genesis, joinA, joinB, gameG1, gameG2, correctG1]);
    expect(gameState.games.map((g) => g.id)).toEqual([gameId("g1"), gameId("g2")]);
    expect(gameState.games[0]).toMatchObject({ scoring: "net" });
  });

  it("excludes the seq envelope field from the canonical tiebreak (non-content metadata must not affect ordering)", () => {
    const collisionHlc = at(30, "device-x");
    const withoutSeq: RoundEvent = { opId: opId("seq-test-1"), hlc: collisionHlc, authorId: A, kind: "score-recorded", golferId: A, hole: 1, result: { kind: "strokes", strokes: 4 } };
    const withSeq: RoundEvent = { ...withoutSeq, seq: 42 };
    const forward = reduceRound([genesis, joinA, started, withoutSeq, withSeq]);
    const backward = reduceRound([genesis, joinA, started, withSeq, withoutSeq]);
    expect(backward).toEqual(forward);
  });
});

// The terminated-set fold: a pure set union over "game-terminated" events. INVARIANT
// (task-1-brief): commutative, idempotent, order-independent, and tolerant of a
// termination arriving before its game-added — every ordering below must fold to the
// identical terminatedGameIds, and state.games must keep the terminated config (audit;
// filtering is a downstream concern, never state's).
describe("reduceRound — game termination", () => {
  const G1 = gameId("g1");
  const gameAdded: RoundEvent = { ...base(4), kind: "game-added", config: { kind: "stroke-play", id: G1, scoring: "gross", players: [A] } };
  const terminated: RoundEvent = { ...base(5), kind: "game-terminated", gameId: G1 };

  it("terminates the game regardless of delivery order: forward, reverse, and shuffled all agree", () => {
    const forward = reduceRound([genesis, joinA, started, gameAdded, terminated]);
    const reverse = reduceRound([terminated, gameAdded, started, joinA, genesis]);
    const shuffled = reduceRound([started, terminated, genesis, gameAdded, joinA]);
    expect(forward.terminatedGameIds).toEqual(new Set([G1]));
    expect(reverse).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it("is idempotent under duplicate delivery of the same termination", () => {
    const once = reduceRound([genesis, joinA, started, gameAdded, terminated]);
    const twice = reduceRound([genesis, joinA, started, gameAdded, terminated, terminated]);
    expect(twice).toEqual(once);
  });

  it("terminates a game whose game-terminated arrives BEFORE its game-added", () => {
    const beforeAdd = reduceRound([genesis, joinA, started, terminated, gameAdded]);
    expect(beforeAdd.terminatedGameIds).toEqual(new Set([G1]));
    // state.games keeps the terminated config — settlement/downstream filters, not state.
    expect(beforeAdd.games.map((g) => g.id)).toEqual([G1]);
  });

  it("keeps terminatedGameIds empty when nothing was ever terminated", () => {
    expect(reduceRound([genesis, joinA, started, gameAdded]).terminatedGameIds).toEqual(new Set());
  });
});

// round-abandoned: a terminal lifecycle event that scraps the round outright (task-15). Unlike
// round-finalized (which round-reopened can un-do), an abandon has NO inverse, so its fold
// behavior is DOMINANT — once the log carries one, status is "abandoned" regardless of any
// later lifecycle event that races in. This is the structural half of "a scrapped round counts
// nowhere": settleRound (archive.test.ts) refuses any log that folds to abandoned.
describe("reduceRound — round abandonment", () => {
  it("folds to status 'abandoned' when a round-abandoned event is present", () => {
    const abandoned: RoundEvent = { ...base(4), kind: "round-abandoned" };
    expect(reduceRound([genesis, joinA, started, abandoned]).status).toBe("abandoned");
  });

  it("is DOMINANT and terminal: a later round-finalized (higher hlc) never resurrects an abandoned round", () => {
    const abandoned: RoundEvent = { ...base(4), kind: "round-abandoned" };
    const finalized: RoundEvent = { ...base(5), kind: "round-finalized" };
    // The finalize lands AFTER the abandon (later hlc) — plain last-wins would make it "final",
    // but abandon has no un-abandon, so the fold stays "abandoned" in EITHER delivery order.
    // This is exactly finalizeRound's own candidate log (events + a fresh round-finalized).
    expect(reduceRound([genesis, joinA, started, abandoned, finalized]).status).toBe("abandoned");
    expect(reduceRound([genesis, joinA, started, finalized, abandoned]).status).toBe("abandoned");
  });

  it("folds identically under any delivery order (forward, reverse, shuffled)", () => {
    const abandoned: RoundEvent = { ...base(4), kind: "round-abandoned" };
    const forward = reduceRound([genesis, joinA, started, abandoned]);
    const reverse = reduceRound([abandoned, started, joinA, genesis]);
    const shuffled = reduceRound([started, abandoned, genesis, joinA]);
    expect(forward.status).toBe("abandoned");
    expect(reverse).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it("is idempotent under duplicate delivery of the same abandon", () => {
    const abandoned: RoundEvent = { ...base(4), kind: "round-abandoned" };
    const once = reduceRound([genesis, joinA, started, abandoned]);
    const twice = reduceRound([genesis, joinA, started, abandoned, abandoned]);
    expect(twice).toEqual(once);
  });
});

// participant-left: presence resolves by HLC exactly the way a score cell does
// (accounts-only identity spec §4). For each golferId the latest of {participant-joined,
// participant-left} by the existing HLC total order decides presence — a leave later than
// their latest join marks them `departed: true`; a rejoin (a still-later join) clears it and
// applies its own seat data. Seat data and presence are SEPARATE concerns: a departed golfer
// still renders on the roster with their latest join's seat data. INVARIANT: the fold stays
// commutative — every delivery order (including a leave that folds in BEFORE its join) folds
// to the identical state — and `departed` is present only when true, so a round with no
// departures is byte-identical to one folded before this field existed.
describe("reduceRound — participant leaving (presence by HLC)", () => {
  // The domain does NOT enforce self-authorship — the event records golferId (who left);
  // authorId follows the ordinary envelope convention (here base()'s default A). The
  // "you can only leave yourself" rule lives in the API layer, not the fold.
  const leaveAt = (wallMs: number, golfer = A, device = "d1"): RoundEvent => ({ ...base(wallMs, device), kind: "participant-left", golferId: golfer });
  const rejoinAt = (wallMs: number, strokes: number): RoundEvent => ({
    ...base(wallMs),
    kind: "participant-joined",
    participant: { golferId: A, name: "Ann", tee: "white", strokes },
  });

  it("marks a participant departed when a participant-left is later than their latest join", () => {
    const state = reduceRound([genesis, joinA, started, leaveAt(10)]);
    expect(state.participants).toHaveLength(1);
    expect(state.participants[0]?.golferId).toBe(A);
    expect(state.participants[0]?.departed).toBe(true);
  });

  it("leaves 'departed' absent (default present) for a participant who never left", () => {
    const state = reduceRound([genesis, joinA, started]);
    // `in`, not toBeUndefined(): the field must be genuinely ABSENT (default false), so a
    // round with no departures serializes identically to one folded before this field existed.
    expect("departed" in state.participants[0]!).toBe(false);
  });

  it("rejoin (a later join) clears departed and applies the rejoin's seat data", () => {
    const state = reduceRound([genesis, joinA, started, leaveAt(10), rejoinAt(20, 12)]);
    expect(state.participants).toHaveLength(1);
    expect("departed" in state.participants[0]!).toBe(false);
    expect(state.participants[0]?.strokes).toBe(12); // the rejoin's seat data wins by hlc
  });

  it("a departed participant still renders with their latest join's seat data (leaving never erases the seat)", () => {
    const fixTee = rejoinAt(5, 9); // a correcting re-join BEFORE the leave
    const state = reduceRound([genesis, joinA, fixTee, started, leaveAt(10)]);
    expect(state.participants[0]?.departed).toBe(true);
    expect(state.participants[0]?.strokes).toBe(9);
  });

  it("a participant-left for a golfer with no join yet seen creates no seat and never crashes", () => {
    const state = reduceRound([genesis, started, leaveAt(10)]); // A never joined
    expect(state.participants).toHaveLength(0);
  });

  it("converges when a participant-left folds in BEFORE its participant-joined (arrival order must not matter)", () => {
    const leave = leaveAt(10);
    const joinThenLeave = reduceRound([genesis, joinA, started, leave]);
    const leaveThenJoin = reduceRound([genesis, started, leave, joinA]); // the leave arrives first
    expect(leaveThenJoin).toEqual(joinThenLeave);
    expect(leaveThenJoin.participants[0]?.departed).toBe(true); // join(2) < leave(10) → departed
  });

  it("converges over shuffled orders of a join→leave→join→leave chain (latest is a leave → departed)", () => {
    const leave1 = leaveAt(4);
    const rejoin = rejoinAt(6, 15);
    const leave2 = leaveAt(8);
    const log = [genesis, started, joinA, leave1, rejoin, leave2];
    const forward = reduceRound(log);
    const reverse = reduceRound([...log].reverse());
    const shuffled = reduceRound([leave2, genesis, rejoin, started, leave1, joinA]);
    expect(forward.participants[0]?.departed).toBe(true); // latest event is leave2(8) > rejoin(6)
    expect(forward.participants[0]?.strokes).toBe(15); // latest join is the rejoin
    expect(reverse).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it("converges to present over shuffled orders of a join→leave→join chain (latest is a join)", () => {
    const leave1 = leaveAt(4);
    const rejoin = rejoinAt(6, 15);
    const log = [genesis, started, joinA, leave1, rejoin];
    const forward = reduceRound(log);
    const shuffled = reduceRound([rejoin, leave1, genesis, joinA, started]);
    expect("departed" in forward.participants[0]!).toBe(false); // latest event is rejoin(6) > leave1(4)
    expect(shuffled).toEqual(forward);
  });

  it("converges on a game-add referencing a departed golfer in any arrival order — game exists, player departed, holes unscored (no dominance, no voiding)", () => {
    const joinB: RoundEvent = { ...base(2), kind: "participant-joined", participant: { golferId: B, name: "Bea", tee: "white", strokes: 12 } };
    const gameAB: RoundEvent = { ...base(6), kind: "game-added", config: { kind: "stroke-play", id: gameId("g1"), scoring: "gross", players: [A, B] } };
    const leave = leaveAt(10);
    const forward = reduceRound([genesis, joinA, joinB, started, gameAB, leave]);
    const reverse = reduceRound([leave, gameAB, started, joinB, joinA, genesis]);
    const shuffled = reduceRound([gameAB, genesis, leave, started, joinA, joinB]);
    expect(reverse).toEqual(forward);
    expect(shuffled).toEqual(forward);
    expect(forward.games.map((g) => g.id)).toEqual([gameId("g1")]); // game still exists
    expect(forward.participants.find((p) => p.golferId === A)?.departed).toBe(true); // player departed
    expect(Object.keys(forward.cells)).toHaveLength(0); // holes unscored — scoreGame untouched
  });

  it("a participant-left after round-finalized does not change the terminal status (a leave is not a lifecycle event)", () => {
    const finalized: RoundEvent = { ...base(10), kind: "round-finalized" };
    expect(reduceRound([genesis, joinA, started, finalized, leaveAt(20)]).status).toBe("final");
  });

  it("a participant-left after round-abandoned does not change the terminal status", () => {
    const abandoned: RoundEvent = { ...base(10), kind: "round-abandoned" };
    expect(reduceRound([genesis, joinA, started, abandoned, leaveAt(20)]).status).toBe("abandoned");
  });
});

// Strokes are ASSERTED, never derived (spec 2026-07-30 §2): the group does the subtraction on the
// first tee and types the answer. The fold's whole job is to seat the number it was given and
// apply a later correction — nothing here reads another seat, which is the point of the arc.
describe("reduceRound — asserted strokes", () => {
  const BLAINE = golferId("blaine");
  const RAVI = golferId("ravi");
  // Local builders (not the file's joinA/base) so each event's hlc is explicit — the
  // set-vs-latest-join rule turns on HLC ordering.
  const joined = (golfer: GolferId, strokes: number, wallMs: number): RoundEvent => ({
    ...base(wallMs),
    kind: "participant-joined",
    participant: { golferId: golfer, name: golfer, tee: "white", strokes },
  });
  const strokesSet = (golfer: GolferId, strokes: number, wallMs: number): RoundEvent => ({
    ...base(wallMs),
    kind: "participant-strokes-set",
    golferId: golfer,
    strokes,
  });
  const seatOf = (state: ReturnType<typeof reduceRound>, golfer: GolferId) => state.participants.find((p) => p.golferId === golfer);

  it("seats a player at zero strokes unless someone sets them", () => {
    const state = reduceRound([genesis, joined(BLAINE, 0, 2)]);
    expect(seatOf(state, BLAINE)?.strokes).toBe(0);
  });

  it("applies a strokes-set that is HLC-later than the join", () => {
    const state = reduceRound([genesis, joined(BLAINE, 0, 2), strokesSet(BLAINE, 20, 3)]);
    expect(seatOf(state, BLAINE)?.strokes).toBe(20);
  });

  it("ignores a strokes-set older than the golfer's latest join", () => {
    const state = reduceRound([genesis, strokesSet(BLAINE, 20, 2), joined(BLAINE, 0, 3)]);
    expect(seatOf(state, BLAINE)?.strokes).toBe(0);
  });

  it("leaves one player's strokes alone when another's are set", () => {
    // The point of the whole arc: nothing about one player's number moves another's. Under the
    // derivation this replaced, setting Blaine to 20 could re-anchor Ravi's entire card.
    const state = reduceRound([genesis, joined(BLAINE, 0, 2), joined(RAVI, 0, 3), strokesSet(BLAINE, 20, 4)]);
    expect(seatOf(state, BLAINE)?.strokes).toBe(20);
    expect(seatOf(state, RAVI)?.strokes).toBe(0);
  });
});

describe("participant-strokes-set", () => {
  const setA = (wallMs: number, strokes: number): RoundEvent => ({
    ...base(wallMs),
    kind: "participant-strokes-set",
    golferId: A,
    strokes,
  });

  it("a set later than the join overrides the seat's strokes in place", () => {
    const state = reduceRound([genesis, joinA, started, setA(10, 13)]);
    const seat = state.participants.find((p) => p.golferId === A);
    expect(seat?.strokes).toBe(13);
    // Everything else about the seat is the join's own data, untouched — the event structurally
    // cannot carry a name or a tee.
    expect(seat?.name).toBe("Ann");
    expect(seat?.tee).toBe("white");
  });

  it("is order-independent: the set folds identically wherever it lands in arrival order", () => {
    const events = [genesis, joinA, started, setA(10, 13)];
    const shuffled = [events[3], events[0], events[2], events[1]] as RoundEvent[];
    expect(reduceRound(shuffled)).toEqual(reduceRound(events));
  });

  it("latest set wins among multiple sets", () => {
    const state = reduceRound([genesis, joinA, started, setA(10, 13), setA(11, 2)]);
    expect(state.participants.find((p) => p.golferId === A)?.strokes).toBe(2);
  });

  it("a REJOIN later than a set wins — the fresh join's number applies", () => {
    const leave: RoundEvent = { ...base(11), kind: "participant-left", golferId: A };
    const rejoin: RoundEvent = { ...base(12), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", strokes: 20 } };
    const state = reduceRound([genesis, joinA, started, setA(10, 13), leave, rejoin]);
    const seat = state.participants.find((p) => p.golferId === A);
    expect(seat?.strokes).toBe(20);
    expect(seat?.departed).toBeUndefined();
  });

  it("a set earlier than the latest join loses to that join", () => {
    const leave: RoundEvent = { ...base(11), kind: "participant-left", golferId: A };
    const rejoin: RoundEvent = { ...base(13), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", strokes: 20 } };
    // Set minted between the leave and the rejoin — the rejoin's later hlc supersedes it.
    const state = reduceRound([genesis, joinA, started, leave, setA(12, 13), rejoin]);
    expect(state.participants.find((p) => p.golferId === A)?.strokes).toBe(20);
  });

  it("corrects a DEPARTED golfer's strokes without re-seating them", () => {
    const leave: RoundEvent = { ...base(11), kind: "participant-left", golferId: A };
    const state = reduceRound([genesis, joinA, started, leave, setA(12, 13)]);
    const seat = state.participants.find((p) => p.golferId === A);
    expect(seat?.strokes).toBe(13);
    expect(seat?.departed).toBe(true); // presence untouched — the set is not a join
  });

  it("a set for a golfer with no folded join contributes nothing and never throws", () => {
    const setB: RoundEvent = { ...base(10), kind: "participant-strokes-set", golferId: B, strokes: 5 };
    const state = reduceRound([genesis, joinA, started, setB]);
    expect(state.participants.map((p) => p.golferId)).toEqual([A]);
  });
});

// Spec §2d extended from one cell to many (task-4 review fix): a set of holes has a gross iff
// EVERY hole in it has a decided, scored cell. Built with hand-made cells, independent of
// reduceRound — the fold isn't under test here, only the "sum, or undefined" rule itself.
describe("grossForHoles", () => {
  const holes = card.teeSets[0]!.holes; // 3 holes: par 4, par 4, par 3
  const cell = (result: HoleResult): ScoreCell => ({ result, recordedBy: A, hlc: at(1), opId: opId(`op-${op++}`) });

  it("sums scoredStrokes across every hole when all three are decided", () => {
    const cells: Record<string, ScoreCell> = {
      [cellKey(A, 1)]: cell({ kind: "strokes", strokes: 5 }),
      [cellKey(A, 2)]: cell({ kind: "strokes", strokes: 4 }),
      [cellKey(A, 3)]: cell({ kind: "strokes", strokes: 3 }),
    };
    expect(grossForHoles(cells, A, holes)).toBe(12);
  });

  it("is undefined when any hole in the set has a picked-up cell — never a silent zero for it", () => {
    const cells: Record<string, ScoreCell> = {
      [cellKey(A, 1)]: cell({ kind: "strokes", strokes: 5 }),
      [cellKey(A, 2)]: cell({ kind: "picked-up" }),
      [cellKey(A, 3)]: cell({ kind: "strokes", strokes: 3 }),
    };
    expect(grossForHoles(cells, A, holes)).toBeUndefined();
  });

  it("is undefined when a hole was never recorded at all", () => {
    const cells: Record<string, ScoreCell> = {
      [cellKey(A, 1)]: cell({ kind: "strokes", strokes: 5 }),
      [cellKey(A, 2)]: cell({ kind: "strokes", strokes: 4 }),
      // hole 3: no cell — the card just never reached it.
    };
    expect(grossForHoles(cells, A, holes)).toBeUndefined();
  });

  it("is undefined when a hole's cell was cleared — cellAt hides it exactly like unscored", () => {
    const cells: Record<string, ScoreCell> = {
      [cellKey(A, 1)]: cell({ kind: "strokes", strokes: 5 }),
      [cellKey(A, 2)]: cell({ kind: "cleared" }),
      [cellKey(A, 3)]: cell({ kind: "strokes", strokes: 3 }),
    };
    expect(grossForHoles(cells, A, holes)).toBeUndefined();
  });

  it("reads only the requested golfer's cells — another golfer's complete card doesn't leak in", () => {
    const cells: Record<string, ScoreCell> = {
      [cellKey(B, 1)]: cell({ kind: "strokes", strokes: 5 }),
      [cellKey(B, 2)]: cell({ kind: "strokes", strokes: 4 }),
      [cellKey(B, 3)]: cell({ kind: "strokes", strokes: 3 }),
    };
    expect(grossForHoles(cells, A, holes)).toBeUndefined();
  });

  it("an empty hole list has a gross of zero — vacuously true, matching a fold's own empty identity", () => {
    expect(grossForHoles({}, A, [])).toBe(0);
  });
});

// The static par total (task-5 fix round, spec 2026-07-30 §10 review — one copy replacing two
// hand-rolled `reduce((sum, hole) => sum + hole.par, 0)` sites in apps/web/src).
describe("parForHoles", () => {
  const holes = card.teeSets[0]!.holes; // par 4, par 4, par 3

  it("sums par across every hole", () => {
    expect(parForHoles(holes)).toBe(11);
  });

  it("is zero for an empty hole list", () => {
    expect(parForHoles([])).toBe(0);
  });
});
