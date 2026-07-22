// Presentation-only arithmetic view logic over numbers the wire already computed (ags − par; a
// literal join of already-summed typicalEighteen buckets) — never golf rules, so no @swng/domain
// compute import is warranted (the ESLint compute fence stays clean). Hoisted verbatim from
// apps/web/src/golfers/RecordSections.tsx (crew-scoreboard spec, Task 3) — the crew scoreboard's
// own `best18`/`netPer18` columns reuse the SAME sign convention, so this is now the one copy.
export const vsPar = (ags: number, par: number): string => {
  const d = ags - par;
  return d === 0 ? "E" : d > 0 ? `+${d}` : `${d}`;
};
