import type { GameId, GolferId, OpId, RoundId } from "../ids.js";
import type { CourseCard } from "../course/card.js";
import { DomainError } from "../errors.js";
import { compareHlc, type Hlc } from "./hlc.js";
import type { HoleResult } from "./holeResult.js";
import type { Participant, RosterEntry } from "./participant.js";
import type { GameConfig, RoundEvent } from "./events.js";

// "abandoned" is a TERMINAL status like "final", but for a scrapped round rather than a settled
// one (task-15): unlike "final" (which round-reopened can flip back to "live"), nothing ever
// leaves "abandoned" — an abandon has no inverse. settleRound refuses an abandoned log, so a
// scrapped round produces no snapshot and counts nowhere.
export type RoundStatus = "setup" | "live" | "final" | "abandoned";

export interface ScoreCell {
  readonly result: HoleResult;
  readonly recordedBy: GolferId;
  readonly hlc: Hlc;
  readonly opId: OpId;
}

export interface RoundState {
  readonly id: RoundId;
  readonly status: RoundStatus;
  readonly card: CourseCard;
  readonly participants: readonly RosterEntry[];
  readonly games: readonly GameConfig[];
  readonly cells: Readonly<Record<string, ScoreCell>>;
  // Every "game-terminated" gameId ever seen, terminated or not yet added — a config
  // stays in `games` (audit trail) even once its id lands here; settlement and every
  // other downstream consumer decide their own filtering (see the fold's step below).
  readonly terminatedGameIds: ReadonlySet<GameId>;
}

export const cellKey = (golfer: GolferId, hole: number): string => `${golfer}#${hole}`;

// The ONE way to read a scored cell: absent and cleared are both "unscored". Every
// engine/walk reads through this — a raw state.cells[...] read would silently treat a
// cleared cell as a score. Takes the bare cells record so archive.cells readers
// (golfer/record.ts) share it.
export const cellAt = (cells: Readonly<Record<string, ScoreCell>>, golferId: GolferId, hole: number): ScoreCell | undefined => {
  const cell = cells[cellKey(golferId, hole)];
  return cell && cell.result.kind !== "cleared" ? cell : undefined;
};

const LIFECYCLE_STATUS: Record<"round-created" | "round-started" | "round-finalized" | "round-reopened" | "round-abandoned", RoundStatus> = {
  "round-created": "setup",
  "round-started": "live",
  "round-finalized": "final",
  "round-reopened": "live",
  "round-abandoned": "abandoned",
};

// Deterministic serialization with explicitly sorted object keys — NOT plain
// JSON.stringify, whose key order is insertion-dependent and therefore not a
// canonical representation of the value.
const canonicalStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

// withoutSeq and byCanonicalOrder are deliberately published via the barrel (not
// module-private) — sync/journal tooling and M4 tests are the intended consumers.
//
// seq is server-assigned canonical-order metadata (see events.ts), not event content —
// a seq-stamped copy of an op (post-ack) and its unstamped copy (pre-ack, still in a
// client's outbox) must tiebreak identically, so it's excluded before serializing.
// Return type is RoundEvent, not Omit<RoundEvent, "seq"> — seq is already optional on
// RoundEventBase, so a copy missing it is still a valid RoundEvent, and typing it that
// way (rather than Omit, which collapses a discriminated union to its common keys)
// keeps this composable with call sites that need a real RoundEvent back, e.g. the
// archive's canonical event log.
export const withoutSeq = (event: RoundEvent): RoundEvent => {
  const rest: Record<string, unknown> = { ...event };
  delete rest.seq;
  // Two-step cast: TS's single-step assertion rejects Record<string, unknown> -> RoundEvent
  // as "insufficient overlap" against a discriminated union, even though every payload key
  // is still present at runtime — only "seq" was ever removed.
  return rest as unknown as RoundEvent;
};

// Total order over events that depends only on event content (hlc, then opId, then a
// full canonical serialization as a last-resort tiebreak), never on array position.
// Every downstream step processes events in this canonical order, which is what makes
// the whole fold a pure function of the event *set* rather than of delivery/arrival
// order — true commutativity, not just "commutative unless two ops happen to collide."
//
// The third term matters for the dedupe-collision case this comparator exists to make
// deterministic: two events that share an opId (and, in the worst case, an identical
// hlc too) but carry different payloads. Without it, (hlc, opId) both compare equal and
// the comparator returns 0 for genuinely different events — 0 only for identical events
// is required; otherwise stable sort would fall back to arrival order and break
// convergence.
export const byCanonicalOrder = (a: RoundEvent, b: RoundEvent): number => {
  const contentA = withoutSeq(a);
  const contentB = withoutSeq(b);
  return (
    compareHlc(a.hlc, b.hlc) ||
    (a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0) ||
    (canonicalStringify(contentA) < canonicalStringify(contentB) ? -1 : canonicalStringify(contentA) > canonicalStringify(contentB) ? 1 : 0)
  );
};

export const reduceRound = (events: readonly RoundEvent[]): RoundState => {
  // Every sub-structure is an hlc-resolved LWW register/map, which is what makes
  // the whole fold commutative: any delivery order converges (property-tested).

  // 1. Canonicalize order, then dedupe by opId (keep first occurrence in canonical
  //    order; verbatim retries are content-identical so which copy survives is moot).
  const sorted = [...events].sort(byCanonicalOrder);
  const seenOps = new Set<OpId>();
  const deduped: RoundEvent[] = [];
  for (const event of sorted) {
    if (seenOps.has(event.opId)) continue;
    seenOps.add(event.opId);
    deduped.push(event);
  }

  // 2. Genesis: among "round-created" events pick highest hlc (last in canonical
  //    ascending order); none present → throw.
  let genesis: Extract<RoundEvent, { kind: "round-created" }> | undefined;
  for (const event of deduped) {
    if (event.kind === "round-created") genesis = event;
  }
  if (!genesis) throw new DomainError("round-log-missing-genesis");

  // 3. Status: among lifecycle events pick highest hlc (last in canonical order).
  let status: RoundStatus = LIFECYCLE_STATUS["round-created"];
  for (const event of deduped) {
    if (event.kind in LIFECYCLE_STATUS) {
      status = LIFECYCLE_STATUS[event.kind as keyof typeof LIFECYCLE_STATUS];
    }
  }
  // round-abandoned is TERMINAL and DOMINANT, unlike every other lifecycle event: a round is
  // scrapped for good — there is no un-abandon event the way round-reopened un-finalizes — so
  // once the log carries ONE abandon the fold is "abandoned" regardless of any later
  // round-finalized/round-started/round-reopened that races in with a higher hlc. Expressed as a
  // dominant override AFTER the last-wins scan above (not as a plain reliance on the
  // LIFECYCLE_STATUS entry) precisely because last-wins alone would let a later finalize win.
  // This is what makes "a scrapped round counts nowhere" STRUCTURAL: settleRound (archive.ts)
  // throws on any log that folds to "abandoned", including finalizeRound's own candidate log
  // (its appended round-finalized can never out-vote an abandon already on the log). It stays
  // commutative/idempotent — a pure set-membership check over the log, order-independent.
  if (deduped.some((event) => event.kind === "round-abandoned")) status = "abandoned";

  // 4. participants: seat data is an LWW map keyed by golferId (latest join wins), but roster
  //    ORDER is join order — tracked separately as the first-write hlc — while the payload
  //    stays LWW. Canonical ascending processing order means the first time we see a golferId
  //    is necessarily their earliest write, and a later overwrite always has hlc >= the one it
  //    replaces, so a correction updates the payload in place without moving the golfer to the
  //    end of the roster.
  //
  //    Presence layers on top, resolved by HLC exactly like a score cell: for each golferId
  //    the latest of {participant-joined, participant-left} by the total order decides
  //    `departed` — a leave strictly later than that golfer's latest join marks them departed;
  //    a rejoin (a still-later join) clears it. Seat data and presence are SEPARATE concerns,
  //    so a departed golfer keeps their latest join's seat data on the roster. A leave for a
  //    golferId with no join yet folded creates no seat and never throws — its hlc just waits
  //    in leavesByGolfer for a join that may or may not arrive, which is what keeps the fold
  //    commutative over a leave that lands before its join. `departed` is set only when true
  //    (absent ≡ present, the default), so a departure-free round is byte-identical to before.
  const seatByGolfer = new Map<GolferId, { participant: Participant; latestJoinHlc: Hlc; firstHlc: Hlc }>();
  const leavesByGolfer = new Map<GolferId, Hlc>();
  for (const event of deduped) {
    if (event.kind === "participant-joined") {
      const existing = seatByGolfer.get(event.participant.golferId);
      seatByGolfer.set(event.participant.golferId, { participant: event.participant, latestJoinHlc: event.hlc, firstHlc: existing?.firstHlc ?? event.hlc });
    } else if (event.kind === "participant-left") {
      const existing = leavesByGolfer.get(event.golferId);
      if (!existing || compareHlc(event.hlc, existing) > 0) leavesByGolfer.set(event.golferId, event.hlc);
    }
  }
  const participants: RosterEntry[] = [...seatByGolfer.values()]
    .sort((a, b) => compareHlc(a.firstHlc, b.firstHlc) || (a.participant.golferId < b.participant.golferId ? -1 : a.participant.golferId > b.participant.golferId ? 1 : 0))
    .map(({ participant, latestJoinHlc }) => {
      const leaveHlc = leavesByGolfer.get(participant.golferId);
      const departed = leaveHlc !== undefined && compareHlc(leaveHlc, latestJoinHlc) > 0;
      return departed ? { ...participant, departed: true } : participant;
    });

  // 5. games: same LWW-map treatment keyed by config.id, with the same
  //    join-order-by-first-write-hlc roster ordering as participants (#4).
  const gamesById = new Map<string, { config: GameConfig; hlc: Hlc; firstHlc: Hlc }>();
  for (const event of deduped) {
    if (event.kind !== "game-added") continue;
    const existing = gamesById.get(event.config.id);
    gamesById.set(event.config.id, { config: event.config, hlc: event.hlc, firstHlc: existing?.firstHlc ?? event.hlc });
  }
  const games = [...gamesById.values()]
    .sort((a, b) => compareHlc(a.firstHlc, b.firstHlc) || (a.config.id < b.config.id ? -1 : a.config.id > b.config.id ? 1 : 0))
    .map((entry) => entry.config);

  // 6. terminatedGameIds: a pure set union over "game-terminated" events — no LWW
  //    needed (there's no un-terminate event in v1, so membership never regresses),
  //    which is what makes it commutative and idempotent for free. Deliberately NOT
  //    gated on a matching entry in `games`: a termination for a gameId whose
  //    game-added hasn't been folded yet (or arrives later, or never arrives) still
  //    joins the set — the two registers are independent projections of the same log.
  const terminatedGameIds = new Set<GameId>();
  for (const event of deduped) {
    if (event.kind !== "game-terminated") continue;
    terminatedGameIds.add(event.gameId);
  }

  // 7. cells: keyed by cellKey; apply score-recorded iff absent or the incoming hlc
  //    strictly beats the stored one. On an hlc tie (distinct opIds, same instant),
  //    canonical order makes the winner deterministic regardless of arrival order.
  //    Deliberate asymmetry vs. participants/games (#4, #5) above: cells keep the
  //    FIRST event in canonical order on an exact tie (via "<=" here) while the
  //    lifecycle/participant/game registers keep the LAST (via a max-hlc scan or
  //    an unconditional overwrite in ascending order). Both are equally
  //    deterministic — a tie only ever needs ONE consistent rule, and which one
  //    was picked per register isn't a bug to reconcile, so don't "fix" one to
  //    match the other.
  const cells: Record<string, ScoreCell> = {};
  for (const event of deduped) {
    if (event.kind !== "score-recorded") continue;
    const key = cellKey(event.golferId, event.hole);
    const existing = cells[key];
    if (existing && compareHlc(event.hlc, existing.hlc) <= 0) continue;
    // recordedBy is the WRITE AUTHOR, not the score's subject (golferId) — the
    // subject is already the cell key, so this field only earns its keep by
    // capturing who entered the score, which is not always the golfer themself
    // (score-for-anyone means author !== subject is the normal case).
    cells[key] = { result: event.result, recordedBy: event.authorId, hlc: event.hlc, opId: event.opId };
  }

  // 8. Unknown kinds: never matched by any of the checks above, so they're silently skipped.

  return {
    id: genesis.roundId,
    status,
    card: genesis.card,
    // No crewId register: a round is a sealed leaf, so `genesis` never contributes an
    // outbound crew reference. An old genesis that still carries a stray `crewId` JSON key is
    // simply ignored here (it's not read into state) — the fold tolerates the extra key rather
    // than rejecting an append-only log.
    participants,
    games,
    cells,
    terminatedGameIds,
  };
};
