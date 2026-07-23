// The brand tokens are ONE source of truth (@swng/brand); styles.css's @theme mirrors them because
// Tailwind v4 needs CSS. This pins the mirror two ways: every --color-*/--font-* equals its package
// value, and neither side has an orphan. Editing a color means editing the package AND the CSS —
// drift fails here.
//
// This test lives OUTSIDE src (unlike every other web test) on purpose: it reads styles.css off disk
// with node:fs, which apps/web/src bans (browser code, no Node built-ins), and `styles.css?raw`
// resolves to "" under vitest (its CSS transform blanks .css modules). Here in apps/web/test the
// src-only lint doesn't reach, so fs is the clean way to read the real file.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { brandColors, brandFonts } from "@swng/brand";

// cwd is the package root under both `pnpm -F @swng/web test` and `pnpm -r test` (validate); vitest's
// import.meta.url isn't a file:// scheme, so anchor on cwd rather than the module URL.
const cssText = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

function themeVars(css: string): Record<string, string> {
  const theme = css.match(/@theme\s*\{([\s\S]*?)\}/);
  if (!theme) throw new Error("no @theme block in styles.css");
  const out: Record<string, string> = {};
  for (const line of theme[1]!.split("\n")) {
    const m = line.match(/^\s*(--[\w-]+):\s*(.+?);\s*$/);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

describe("styles.css @theme mirrors @swng/brand", () => {
  const vars = themeVars(cssText);

  it("every brand color is the @theme --color-* value", () => {
    for (const [name, hex] of Object.entries(brandColors)) {
      expect(vars[`--color-${name}`]).toBe(hex);
    }
  });

  it("every brand font is the @theme --font-* value", () => {
    expect(vars["--font-serif"]).toBe(brandFonts.serif);
    expect(vars["--font-mono"]).toBe(brandFonts.mono);
  });

  it("has no --color-*/--font-* token absent from @swng/brand (no orphans)", () => {
    const colorNames = Object.keys(vars)
      .filter((v) => v.startsWith("--color-"))
      .map((v) => v.slice("--color-".length));
    expect(new Set(colorNames)).toEqual(new Set(Object.keys(brandColors)));
    const fontNames = Object.keys(vars)
      .filter((v) => v.startsWith("--font-"))
      .map((v) => v.slice("--font-".length));
    expect(new Set(fontNames)).toEqual(new Set(Object.keys(brandFonts)));
  });
});
