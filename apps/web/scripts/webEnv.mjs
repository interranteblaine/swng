// Generates apps/web/.env.local from apps/infra-cdk/cdk-outputs.json (config.ts's own doc
// comment names this script as its source) — the same beta-stack outputs file `pnpm e2e:beta`
// reads (e2e/support/client.ts's loadEndpoints). Run via `node scripts/webEnv.mjs`, and wired
// as the first step of playwright.config.ts's webServer.command so `vite build` always
// inlines a fresh endpoint pair before `vite preview` serves it (Vite bakes import.meta.env.
// VITE_* into the bundle at build time, not at serve time).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// cdk-outputs.json's HttpApiUrl is slash-terminated (API Gateway's own output format), but
// api.ts and @swng/client's transport.ts both do naive `${base}${path}` string joins — a
// doubled slash there breaks every call (M5 Task 3 review finding). WsApiUrl hasn't been
// observed to carry a trailing slash, but stripping both defensively costs nothing and keeps
// the two endpoints under the same rule rather than a special case. Mirrors
// e2e/support/client.ts's own `apiUrl()` precedent for the identical bug, one directory over.
export const stripTrailingSlash = (url) => url.replace(/\/+$/, "");

// Reads `outputsPath` (a cdk-outputs.json-shaped file: one entry keyed by stack name) and
// writes VITE_HTTP_URL/VITE_WS_URL to `envPath` in dotenv format. Split from the
// run-when-invoked-directly block below so stripTrailingSlash's own unit test can import this
// module without the side effect of touching the filesystem.
export const generateEnvFile = (outputsPath, envPath) => {
  const outputs = JSON.parse(readFileSync(outputsPath, "utf8"));
  const [stackOutputs] = Object.values(outputs);
  if (!stackOutputs) {
    throw new Error(`no stack outputs found in ${outputsPath} — run \`pnpm deploy:beta\` first`);
  }

  const httpUrl = stripTrailingSlash(stackOutputs.HttpApiUrl);
  const wsUrl = stripTrailingSlash(stackOutputs.WsApiUrl);

  writeFileSync(envPath, `VITE_HTTP_URL=${httpUrl}\nVITE_WS_URL=${wsUrl}\n`);
  return { httpUrl, wsUrl };
};

// Only run the filesystem side effect when invoked directly (`node scripts/webEnv.mjs`) —
// importing this module elsewhere (the unit test below) must not touch disk or require a
// real cdk-outputs.json, so `pnpm validate`'s test walk stays hermetic.
if (import.meta.url === `file://${process.argv[1]}`) {
  const outputsPath = fileURLToPath(new URL("../../infra-cdk/cdk-outputs.json", import.meta.url));
  const envPath = fileURLToPath(new URL("../.env.local", import.meta.url));
  const { httpUrl, wsUrl } = generateEnvFile(outputsPath, envPath);
  console.log(`wrote ${envPath}\n  VITE_HTTP_URL=${httpUrl}\n  VITE_WS_URL=${wsUrl}`);
}
