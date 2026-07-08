import type { GolferId, OpId, RoundId } from "../ids.js";
import type { CourseCard } from "../course/card.js";
import { DomainError } from "../errors.js";
import { compareHlc, type Hlc } from "./hlc.js";
import type { HoleResult } from "./holeResult.js";
import type { Participant } from "./participant.js";
import type { GameConfig, RoundEvent } from "./events.js";

export type RoundStatus = "setup" | "live" | "final";

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
  readonly participants: readonly Participant[];
  readonly games: readonly GameConfig[];
  readonly cells: Readonly<Record<string, ScoreCell>>;
}

export const cellKey = (golfer: GolferId, hole: number): string => `${golfer}#${hole}`;

const LIFECYCLE_STATUS: Record<"round-created" | "round-started" | "round-finalized" | "round-reopened", RoundStatus> = {
  "round-created": "setup",
  "round-started": "live",
  "round-finalized": "final",
  "round-reopened": "live",
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
const byCanonicalOrder = (a: RoundEvent, b: RoundEvent): number =>
  compareHlc(a.hlc, b.hlc) ||
  (a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0) ||
  (canonicalStringify(a) < canonicalStringify(b) ? -1 : canonicalStringify(a) > canonicalStringify(b) ? 1 : 0);

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

  // 4. participants: LWW map keyed by golferId. Canonical ascending processing order
  //    means a later overwrite always has hlc >= the one it replaces.
  const participantsByGolfer = new Map<GolferId, { participant: Participant; hlc: Hlc }>();
  for (const event of deduped) {
    if (event.kind !== "participant-joined") continue;
    participantsByGolfer.set(event.participant.golferId, { participant: event.participant, hlc: event.hlc });
  }
  const participants = [...participantsByGolfer.values()]
    .sort((a, b) => compareHlc(a.hlc, b.hlc) || (a.participant.golferId < b.participant.golferId ? -1 : a.participant.golferId > b.participant.golferId ? 1 : 0))
    .map((entry) => entry.participant);

  // 5. games: same LWW-map treatment keyed by config.id.
  const gamesById = new Map<string, { config: GameConfig; hlc: Hlc }>();
  for (const event of deduped) {
    if (event.kind !== "game-added") continue;
    gamesById.set(event.config.id, { config: event.config, hlc: event.hlc });
  }
  const games = [...gamesById.values()]
    .sort((a, b) => compareHlc(a.hlc, b.hlc) || (a.config.id < b.config.id ? -1 : a.config.id > b.config.id ? 1 : 0))
    .map((entry) => entry.config);

  // 6. cells: keyed by cellKey; apply score-recorded iff absent or the incoming hlc
  //    strictly beats the stored one. On an hlc tie (distinct opIds, same instant),
  //    canonical order makes the winner deterministic regardless of arrival order.
  const cells: Record<string, ScoreCell> = {};
  for (const event of deduped) {
    if (event.kind !== "score-recorded") continue;
    const key = cellKey(event.golferId, event.hole);
    const existing = cells[key];
    if (existing && compareHlc(event.hlc, existing.hlc) <= 0) continue;
    cells[key] = { result: event.result, recordedBy: event.golferId, hlc: event.hlc, opId: event.opId };
  }

  // 7. Unknown kinds: never matched by any of the checks above, so they're silently skipped.

  return {
    id: genesis.roundId,
    status,
    card: genesis.card,
    participants,
    games,
    cells,
  };
};
