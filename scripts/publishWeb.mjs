// Publishes apps/web to the hosted beta origin (M9 Task 6): builds with the beta env (the
// SAME VITE_* values apps/web/scripts/webEnv.mjs already assembles from
// apps/infra-cdk/cdk-outputs.json — reused here directly, not re-implemented), syncs the build
// to the WebBucket, then invalidates the CloudFront distribution's cache. Run via
// `pnpm publish:web:beta` (root package.json). `--dry-run` builds only, with no AWS calls at
// all — so the build path can be proven working before a deploy exists to publish against.
//
// authConfig.ts's redirectUri/buildLogoutUrl both derive from `window.location.origin` at
// RUNTIME, not a build-time env var (confirmed by reading apps/web/src/auth/authConfig.ts) —
// so this ONE build works unmodified whether it's served from localhost or the CloudFront
// origin. No per-origin build flag is needed here, unlike the VITE_* endpoint values below
// which genuinely are baked in at build time (Vite inlines import.meta.env.VITE_* then, not at
// serve time) but are origin-independent (the beta API/Cognito pool are the same regardless of
// which origin serves the SPA).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateEnvFile } from "../apps/web/scripts/webEnv.mjs";

const dryRun = process.argv.includes("--dry-run");

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const outputsPath = fileURLToPath(new URL("../apps/infra-cdk/cdk-outputs.json", import.meta.url));
const envPath = fileURLToPath(new URL("../apps/web/.env.local", import.meta.url));
const distDir = fileURLToPath(new URL("../apps/web/dist", import.meta.url));

const { httpUrl, wsUrl, hostedUiDomain } = generateEnvFile(outputsPath, envPath);
console.log(`web env written from ${outputsPath}\n  VITE_HTTP_URL=${httpUrl}\n  VITE_WS_URL=${wsUrl}\n  VITE_HOSTED_UI_DOMAIN=${hostedUiDomain}`);

console.log("building apps/web (pnpm -F @swng/web build)...");
execFileSync("pnpm", ["-F", "@swng/web", "build"], { cwd: repoRoot, stdio: "inherit" });

if (dryRun) {
  console.log("--dry-run: build complete, skipping S3 sync + CloudFront invalidation.");
  process.exit(0);
}

// WebBucketName/DistributionId are this stack's own CfnOutputs (swngStack.ts, M9 Task 6) — read
// fresh every run so a stale local cdk-outputs.json never silently syncs to last deploy's
// bucket/distribution.
const outputs = JSON.parse(readFileSync(outputsPath, "utf8"));
const [stackOutputs] = Object.values(outputs);
const bucketName = stackOutputs?.WebBucketName;
const distributionId = stackOutputs?.DistributionId;
if (!bucketName || !distributionId) {
  throw new Error(
    `WebBucketName/DistributionId missing from ${outputsPath} — run \`pnpm deploy:beta\` first (this task's CfnOutputs land with that deploy).`,
  );
}

console.log(`syncing ${distDir} -> s3://${bucketName} (profile swng)...`);
execFileSync("aws", ["s3", "sync", distDir, `s3://${bucketName}`, "--delete", "--profile", "swng"], { stdio: "inherit" });

// CloudFront caches origin responses — an S3 sync alone leaves the CDN serving the PREVIOUS
// build's HTML/JS until each object's TTL expires, so every publish invalidates everything.
console.log(`invalidating CloudFront distribution ${distributionId}...`);
execFileSync("aws", ["cloudfront", "create-invalidation", "--distribution-id", distributionId, "--paths", "/*", "--profile", "swng"], {
  stdio: "inherit",
});

console.log("done.");
