// The shared visual idioms (spec §6) — class-string constants so <button>, <Link>, and
// <input> can all wear them. One copy: composing surfaces import these; re-typing an
// idiom inline is a review defect. Uppercase is CSS — JSX copy stays sentence-case.
export const btnPrimary =
  "bg-gold px-6 py-4 text-center text-sm font-bold tracking-widest text-forest uppercase";
export const btnSecondary =
  "border border-forest px-6 py-3.5 text-center text-sm font-semibold tracking-widest text-forest uppercase";
export const btnCreamOutline =
  "border border-cream/55 px-6 py-3 text-center text-sm font-semibold tracking-widest text-cream uppercase";
export const btnDanger =
  "border border-oxblood px-4 py-3 text-center text-sm font-semibold tracking-widest text-oxblood uppercase";
export const btnDangerSolid =
  "bg-oxblood px-4 py-3 text-center text-sm font-semibold tracking-widest text-cream uppercase";
export const cardBox = "border border-hairline bg-card";
export const eyebrow = "font-mono text-[11px] tracking-[2px] text-fairway uppercase";
export const inputBox =
  "border border-hairline bg-card px-3 py-3 text-forest placeholder:text-oxblood";
export const inputCode =
  "border border-hairline bg-card px-3 py-3 font-mono tracking-[2px] text-forest placeholder:text-oxblood";
