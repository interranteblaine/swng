import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { buildApp } from "../compositionRoot.js";
import type { App } from "../compositionRoot.js";
import { fromApiGatewayEvent, toApiGatewayResult } from "../http/apiGatewayAdapter.js";

// Composition happens ONCE per cold start (conventions §3, M3 plan) — but buildApp is async
// since prod-readiness hardening Arc A Task 4 (it awaits the token-signing secret from
// Secrets Manager), so a synchronous module-scope `const app = buildApp(...)` no longer
// works. A lazily-initialized, cached Promise gets the same "once per cold start, every warm
// invocation reuses it" invariant without a top-level await (avoids bundler-format concerns —
// Task 4 brief).
let appPromise: Promise<App> | undefined;

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  // `??=` alone only reassigns on null/undefined — a REJECTED promise stays cached, and Lambda
  // doesn't recycle a warm container just because a handler throws, so a transient cold-start
  // secret fetch failure (a GetSecretValue throttle/network blip, or an AccessDenied in the
  // narrow deploy window before the grantRead IAM policy attaches) would 500 every request for
  // that container's whole lifetime. Clearing appPromise back to undefined before rethrowing
  // makes the NEXT invocation retry buildApp from scratch instead of replaying the same failure.
  appPromise ??= buildApp(process.env).catch((e) => {
    appPromise = undefined;
    throw e;
  });
  const app = await appPromise;
  return toApiGatewayResult(await app.dispatcher(fromApiGatewayEvent(event)));
};
