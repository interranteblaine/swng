// The shared visual idioms (spec §6) — class-string constants so <button>, <Link>, and
// <input> can all wear them. One copy: composing surfaces import these; re-typing an
// idiom inline is a review defect. Uppercase is CSS — JSX copy stays sentence-case.
export const btnPrimary =
  "bg-gold px-6 py-4 text-center text-sm font-bold tracking-widest text-forest uppercase active:opacity-70";
export const btnSecondary =
  "border border-forest px-6 py-3.5 text-center text-sm font-semibold tracking-widest text-forest uppercase active:opacity-70";
export const btnCreamOutline =
  "border border-cream/55 px-6 py-3 text-center text-sm font-semibold tracking-widest text-cream uppercase active:opacity-70";
export const btnDanger =
  "border border-oxblood px-4 py-3 text-center text-sm font-semibold tracking-widest text-oxblood uppercase active:opacity-70";
export const btnDangerSolid =
  "bg-oxblood px-4 py-3 text-center text-sm font-semibold tracking-widest text-cream uppercase active:opacity-70";
export const cardBox = "border border-hairline bg-card";
export const eyebrow = "font-mono text-[11px] tracking-[2px] text-fairway uppercase";
// A filled status badge — SetupPanel's departed "left" marker and GamePanel/StandingsHeader's
// "Ended" marker are the same idiom, one copy.
export const badge = "bg-fairway px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-cream uppercase";
export const inputBox =
  "border border-hairline bg-card px-3 py-3 text-forest placeholder:text-oxblood";
export const inputCode =
  "border border-hairline bg-card px-3 py-3 font-mono tracking-[2px] text-forest placeholder:text-oxblood";
// A link to a golfer's own record (GolferLink.tsx) — gold as a DECORATION, not a button fill,
// same treatment App.tsx's own header identity link already wears. The brand rule (gold once per
// screen as the primary action) governs FILLED gold; an underline decoration marking "this text
// names an entity you can open" is a different, lighter register — no color/size of its own, so
// it composes under whatever ambient text color/size its caller already set.
export const linkEntity = "underline decoration-gold decoration-2 underline-offset-2";
