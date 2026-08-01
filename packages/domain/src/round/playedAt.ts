import { DomainError } from "../errors.js";
import type { OpId } from "../ids.js";
import type { RoundEvent } from "./events.js";
import { byCanonicalOrder } from "./state.js";

// THE one rule for "when was this round played" (spec 2026-08-01 §3c). Two callers, one
// implementation: reduceRound (so the live round page shows and edits it) and the projector (so
// every participant's line is stamped with the same instant). Two copies would let a live round
// and its own archive disagree about what day it was — which is also why this function dedupes
// by opId ITSELF (fix-wave finding 2), keeping the first occurrence in canonical order, exactly
// reduceRound's own rule: settleRound (archive.ts) sorts its archived events but never dedupes
// them, and the projector calls this function directly over that undeduped log, not through
// reduceRound. Without its own dedupe, a log carrying a same-opId retry pair (a genuine
// duplicate-send, not two distinct corrections) could answer differently here than it does inside
// reduceRound — the exact "a live round and its own archive disagree" failure this function
// exists to prevent, just relocated one level down.
//
// Two arms, no fallback: the latest round-played-at-set by HLC, else the genesis event's own
// playedAtMs. A log with no genesis is corrupt — the same stance reduceRound and createdAtMsOf
// already take, never a silent 0. Genesis presence is tracked explicitly (not inferred from
// "was playedAtMs ever assigned") — a log that somehow carries a round-played-at-set but no
// round-created is still corrupt data and must still throw, exactly like a log with neither.
//
// One ascending scan over byCanonicalOrder — after the dedupe pass — handles both arms:
// canonical order is total and HLC-major, so the last write of either kind is the highest-HLC
// write, and a correction always sorts after the genesis it corrects — no separate "pick the
// max" pass needed for either arm.
export const playedAtMsOf = (events: readonly RoundEvent[]): number => {
  const sorted = [...events].sort(byCanonicalOrder);
  // Dedupe by opId, keeping the FIRST occurrence in canonical order — reduceRound's own rule
  // (state.ts step 1), lifted here so a direct call (settleRound's undeduped archive, the
  // projector) agrees with the fold on the same log. Calling this on an already-deduped list
  // (reduceRound's own call site) is a harmless no-op: every opId already appears once.
  const seenOps = new Set<OpId>();
  const deduped: RoundEvent[] = [];
  for (const event of sorted) {
    if (seenOps.has(event.opId)) continue;
    seenOps.add(event.opId);
    deduped.push(event);
  }
  let hasGenesis = false;
  let playedAtMs = 0;
  for (const event of deduped) {
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
