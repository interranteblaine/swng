// The match-progress core shared by every match-play format (singles today;
// fourball etc. later). Callers reduce a hole to a HoleWinner (or undefined if
// not yet decided) and hand the whole per-hole sequence in card order to this
// function — it owns the up/thru/remaining/dormie/outcome arithmetic exactly
// once instead of every format reimplementing it.
export type HoleWinner = "a" | "b" | "halved";

export type MatchOutcomeAB = { readonly winner: "a" | "b"; readonly closing: string } | { readonly halved: true };

export interface LadderState {
  readonly up: number; // magnitude; 0 = all square
  readonly leader?: "a" | "b"; // absent when up === 0
  readonly thru: number; // decided prefix length
  readonly remaining: number; // totalHoles − thru
  readonly dormie: boolean; // up === remaining && remaining > 0
  readonly outcome?: MatchOutcomeAB;
}

export const matchLadder = (winners: readonly (HoleWinner | undefined)[], totalHoles: number): LadderState => {
  let up = 0; // signed toward "a": positive = a leads, negative = b leads
  let thru = 0;
  let outcome: MatchOutcomeAB | undefined;

  for (const winner of winners) {
    if (outcome) break; // match already closed out — later holes are ignored (junk lives elsewhere)
    // Matches are sequential — an undecided hole means the rest of the card
    // isn't decided either, so the prefix stops here rather than skipping the gap.
    if (winner === undefined) break;

    if (winner === "a") up += 1;
    else if (winner === "b") up -= 1;
    // else "halved": up unchanged

    thru += 1;
    const remaining = totalHoles - thru;

    // Decided on the very last hole reads "N up" (or halved), never "N&0" — check
    // that before the general closeout rule, which would otherwise also match.
    if (remaining === 0) {
      outcome = up === 0 ? { halved: true } : { winner: up > 0 ? "a" : "b", closing: `${Math.abs(up)} up` };
    } else if (Math.abs(up) > remaining) {
      outcome = { winner: up > 0 ? "a" : "b", closing: `${Math.abs(up)}&${remaining}` };
    }
  }

  const remaining = totalHoles - thru;
  const dormie = Math.abs(up) === remaining && remaining > 0;

  return {
    up: Math.abs(up),
    ...(up !== 0 ? { leader: up > 0 ? ("a" as const) : ("b" as const) } : {}),
    thru,
    remaining,
    dormie,
    ...(outcome ? { outcome } : {}),
  };
};
