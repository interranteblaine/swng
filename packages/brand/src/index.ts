// The swng brand tokens — the ONE source of truth, shared across the monorepo (the web's Tailwind
// @theme mirrors these and is pinned to them by a test; apps/infra-cdk builds the Cognito Managed
// Login branding from them; a future React Native app imports them directly). A pure-data leaf:
// depends on nothing, importable by anyone. Relocated verbatim from styles.css @theme (2026-07-23);
// light-only by owner call. Add tokens here ONLY when a real second consumer needs them.
export const brandColors = {
  forest: "#1c2b22",
  fairway: "#3d5a45",
  cream: "#f7f5ef",
  card: "#fffdf8",
  hairline: "#ddd8c9",
  gold: "#c9a356",
  goldwash: "#f3e9d2",
  oxblood: "#8b3a3a",
} as const;

export const brandFonts = {
  serif: 'Georgia, "Iowan Old Style", serif',
  mono: '"Courier New", Courier, monospace',
} as const;
