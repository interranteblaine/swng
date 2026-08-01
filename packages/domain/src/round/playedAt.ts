import { DomainError } from "../errors.js";
import type { RoundEvent } from "./events.js";
import { byCanonicalOrder } from "./state.js";

// THE one rule for "when was this round played" (spec 2026-08-01 §3c). Two callers, one
// implementation: reduceRound (so the live round page shows and edits it) and the projector (so
// every participant's line is stamped with the same instant). Two copies would let a live round
// and its own archive disagree about what day it was.
//
// Two arms, no fallback: the latest round-played-at-set by HLC, else the genesis event's own
// playedAtMs. A log with no genesis is corrupt — the same stance reduceRound and createdAtMsOf
// already take, never a silent 0. Genesis presence is tracked explicitly (not inferred from
// "was playedAtMs ever assigned") — a log that somehow carries a round-played-at-set but no
// round-created is still corrupt data and must still throw, exactly like a log with neither.
//
// One ascending scan over byCanonicalOrder handles both arms: canonical order is total and
// HLC-major, so the last write of either kind is the highest-HLC write, and a correction always
// sorts after the genesis it corrects — no separate "pick the max" pass needed for either arm.
export const playedAtMsOf = (events: readonly RoundEvent[]): number => {
  const sorted = [...events].sort(byCanonicalOrder);
  let hasGenesis = false;
  let playedAtMs = 0;
  for (const event of sorted) {
    if (event.kind === "round-created") {
      hasGenesis = true;
      playedAtMs = event.playedAtMs;
    } else if (event.kind === "round-played-at-set") {
      playedAtMs = event.playedAtMs;
    }
  }
  if (!hasGenesis) throw new DomainError("round-log-missing-genesis");
  return playedAtMs;
};
