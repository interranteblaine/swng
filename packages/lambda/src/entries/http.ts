import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { buildApp } from "../compositionRoot.js";
import type { App } from "../compositionRoot.js";

// Composition happens ONCE per cold start (conventions §3, M3 plan) — but buildApp is async
// since prod-readiness hardening Arc A Task 4 (it awaits the token-signing secret from
// Secrets Manager), so a synchronous module-scope `const app = buildApp(...)` no longer
// works. A lazily-initialized, cached Promise gets the same "once per cold start, every warm
// invocation reuses it" invariant without a top-level await (avoids bundler-format concerns —
// Task 4 brief).
let appPromise: Promise<App> | undefined;

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  appPromise ??= buildApp(process.env);
  const app = await appPromise;
  return app.dispatcher(event);
};
