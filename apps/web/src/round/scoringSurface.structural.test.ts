import { describe, expect, it } from "vitest";
// Vite's `?raw` import suffix (declared ambiently by `vite/client`, referenced in
// vite-env.d.ts) pulls a module's SOURCE TEXT in as a plain string — no `node:fs`, which
// apps/web may never import (it also runs in the browser; eslint.config.mjs's NODE ban on
// `apps/web/src` covers test files too, unlike the golf-compute fence). This is the
// bundler-native equivalent of the readFileSync structural-source-text pin.
import scorecardGridSource from "./ScorecardGrid.tsx?raw";
import scorePadSource from "./ScorePad.tsx?raw";
import statusChromeSource from "./StatusChrome.tsx?raw";

// The link sweep's own carve-out pin (navigation spec, task 6): ScorecardGrid, ScorePad, and
// StatusChrome are the scoring surface — the mis-tap protection the whole two-tap entry rule
// (product.md §9) depends on — and must never sprout a react-router import, which is how a future
// edit could accidentally turn a score cell (or a ScorePad value button) into a navigable link.
// A structural source-text pin, not a render assertion: it catches the import itself, before any
// component even mounts, and survives regardless of how any component's JSX is restructured.
describe("the scoring surface stays linkless (structural)", () => {
  it.each([
    ["ScorecardGrid.tsx", scorecardGridSource],
    ["ScorePad.tsx", scorePadSource],
    ["StatusChrome.tsx", statusChromeSource],
  ])("%s imports nothing from react-router", (_file, source) => {
    expect(source).not.toContain("react-router");
  });
});
