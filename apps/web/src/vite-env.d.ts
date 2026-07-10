/// <reference types="vite/client" />

// Narrows import.meta.env to exactly the vars config.ts/authConfig.ts read — a typo'd key
// (e.g. VITE_HTTP_UR) then fails typecheck instead of silently reading `undefined`.
interface ImportMetaEnv {
  readonly VITE_HTTP_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_USER_POOL_ID: string;
  readonly VITE_USER_POOL_CLIENT_ID: string;
  readonly VITE_HOSTED_UI_DOMAIN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
