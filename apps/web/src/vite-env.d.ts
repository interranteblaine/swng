/// <reference types="vite/client" />

// Narrows import.meta.env to exactly the two endpoints config.ts reads — a typo'd key
// (e.g. VITE_HTTP_UR) then fails typecheck instead of silently reading `undefined`.
interface ImportMetaEnv {
  readonly VITE_HTTP_URL: string;
  readonly VITE_WS_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
