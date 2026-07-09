import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    // Playwright specs (Task 7) live under e2e/ and run via a separate script — they must
    // never be picked up by the default `vitest run` that `pnpm validate` invokes.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
    // Pinned fake endpoints so config.ts (which throws at import time if either is unset)
    // never depends on a real .env.local — `pnpm validate` stays hermetic, no network. Tests
    // that need to exercise config.ts's own missing-env behavior override these per-test via
    // vi.stubEnv.
    env: {
      VITE_HTTP_URL: "https://api.example.test",
      VITE_WS_URL: "wss://ws.example.test",
    },
  },
});
