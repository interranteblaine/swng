import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import WebSocket from "ws";
import type { z } from "zod";
import {
  createCourseRequestSchema,
  createCourseResponseSchema,
  getCourseResponseSchema,
  golferResponseSchema,
  parse,
  searchCoursesResponseSchema,
  updateMeRequestSchema,
  wsEnvelopeSchema,
} from "@swng/contracts";
import type { WsEnvelope } from "@swng/contracts";
import type { CourseCard, CourseId, DeviceId, GolferId, Hlc, OpId, RoundEvent } from "@swng/domain";
import { deviceId as toDeviceId, opId as toOpId } from "@swng/domain";

// --- Endpoints ---------------------------------------------------------------------------

export interface Endpoints {
  readonly httpUrl: string;
  readonly wsUrl: string;
}

// The subset of the swng-beta stack's outputs these suites read — the same cdk-outputs.json
// entry `pnpm deploy:beta` writes and apps/web/scripts/webEnv.mjs reads (one entry keyed by
// stack name, e.g. "swng-beta").
interface StackOutputs {
  readonly HttpApiUrl: string;
  readonly WsApiUrl: string;
  readonly UserPoolId: string;
  readonly UserPoolClientId: string;
}

const readStackOutputs = (unsetEnvHint: string): StackOutputs => {
  const outputsPath = fileURLToPath(new URL("../../apps/infra-cdk/cdk-outputs.json", import.meta.url));
  let outputs: Record<string, StackOutputs>;
  try {
    outputs = JSON.parse(readFileSync(outputsPath, "utf8")) as Record<string, StackOutputs>;
  } catch (error) {
    throw new Error(
      `${unsetEnvHint} and ${outputsPath} could not be read (run \`pnpm deploy:beta\` first, or set the env vars): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const [stackOutputs] = Object.values(outputs);
  if (!stackOutputs) throw new Error(`no stack outputs found in ${outputsPath}`);
  return stackOutputs;
};

// E2E_HTTP_URL / E2E_WS_URL win when both are set; otherwise fall back to whatever
// `cdk deploy` last wrote to apps/infra-cdk/cdk-outputs.json (gitignored).
export const loadEndpoints = (): Endpoints => {
  const envHttp = process.env["E2E_HTTP_URL"];
  const envWs = process.env["E2E_WS_URL"];
  if (envHttp && envWs) return { httpUrl: envHttp, wsUrl: envWs };

  const stackOutputs = readStackOutputs("E2E_HTTP_URL/E2E_WS_URL are unset");
  return { httpUrl: envHttp ?? stackOutputs.HttpApiUrl, wsUrl: envWs ?? stackOutputs.WsApiUrl };
};

// Same env-override-then-outputs-file convention as loadEndpoints above, for the Cognito pool
// mintAccountGolfer (below) mints its throwaway users in.
export interface CognitoPool {
  readonly userPoolId: string;
  readonly userPoolClientId: string;
}

export const loadCognitoPool = (): CognitoPool => {
  const envPool = process.env["E2E_USER_POOL_ID"];
  const envClient = process.env["E2E_USER_POOL_CLIENT_ID"];
  if (envPool && envClient) return { userPoolId: envPool, userPoolClientId: envClient };

  const stackOutputs = readStackOutputs("E2E_USER_POOL_ID/E2E_USER_POOL_CLIENT_ID are unset");
  return { userPoolId: envPool ?? stackOutputs.UserPoolId, userPoolClientId: envClient ?? stackOutputs.UserPoolClientId };
};

// Joins a base URL (with or without a trailing slash — HttpApiUrl carries one, E2E_HTTP_URL
// might not) with a `/`-prefixed path, without ever producing a double slash.
export const apiUrl = (base: string, path: string): string => `${base.replace(/\/+$/, "")}${path}`;

// --- HTTP --------------------------------------------------------------------------------

const jsonHeaders = (token?: string): Record<string, string> => ({
  "content-type": "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

export interface HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
}

const httpError = (method: string, url: string, status: number, body: unknown): HttpError =>
  Object.assign(new Error(`${method} ${url} -> ${status}: ${JSON.stringify(body)}`), { status, body });

// Every response is parsed through its contracts schema before the caller sees it (this
// task's brief) — a malformed wire shape fails the run at the boundary where it happened,
// not three assertions later against a value that was never actually validated.
export const post = async <S extends z.ZodType>(url: string, body: unknown, schema: S, token?: string): Promise<z.infer<S>> => {
  const res = await fetch(url, { method: "POST", headers: jsonHeaders(token), body: body === undefined ? undefined : JSON.stringify(body) });
  const json: unknown = await res.json();
  if (!res.ok) throw httpError("POST", url, res.status, json);
  return parse(schema, json);
};

export const get = async <S extends z.ZodType>(url: string, schema: S, token?: string): Promise<z.infer<S>> => {
  const res = await fetch(url, { headers: jsonHeaders(token) });
  const json: unknown = await res.json();
  if (!res.ok) throw httpError("GET", url, res.status, json);
  return parse(schema, json);
};

export const put = async <S extends z.ZodType>(url: string, body: unknown, schema: S, token?: string): Promise<z.infer<S>> => {
  const res = await fetch(url, { method: "PUT", headers: jsonHeaders(token), body: JSON.stringify(body) });
  const json: unknown = await res.json();
  if (!res.ok) throw httpError("PUT", url, res.status, json);
  return parse(schema, json);
};

// --- Identity: throwaway Cognito accounts (accounts-only identity) -------------------------

// Fixed by the same repo-wide convention apps/web/e2e/support.ts documents for its own copy:
// every AWS-touching spot hardcodes us-east-1; credentials come from the caller's shell
// (AWS_PROFILE=swng or equivalent), never from source.
export const AWS_REGION = "us-east-1";

// Run-scoped, cross-process record of every Cognito user THIS run has minted — the same
// on-disk pattern apps/web/e2e's globalSetup/globalTeardown pair uses (see that support.ts's
// trackMintedUser writeup for why a plain file and not a module binding: test files run in
// separate worker processes, so an in-memory array would only ever hold one file's mints).
// support/globalSetup.ts clears this at run start and deletes every listed user after the
// run. A DISTINCT filename from the web harness's e2e-minted-users.ndjson, so a `pnpm
// e2e:beta` run can never clobber a concurrently-running `pnpm e2e:field`'s own list.
const MINTED_USERS_DIR = fileURLToPath(new URL("../../.superpowers/sdd/", import.meta.url));
export const MINTED_USERS_FILE = `${MINTED_USERS_DIR}e2e-beta-minted-users.ndjson`;

const trackMintedUser = (userPoolId: string, username: string): void => {
  mkdirSync(MINTED_USERS_DIR, { recursive: true });
  appendFileSync(MINTED_USERS_FILE, `${JSON.stringify({ userPoolId, username })}\n`);
};

// Best-effort and NON-FATAL throughout (globalSetup.ts's teardown is the only caller): a
// delete failure — throttling, a user already gone — must never fail a run whose tests have
// all already reported their own pass/fail. Mirrors apps/web/e2e/globalTeardown.ts exactly.
export const deleteMintedUsers = async (): Promise<void> => {
  if (!existsSync(MINTED_USERS_FILE)) return; // nothing was ever minted this run

  const lines = readFileSync(MINTED_USERS_FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const cognito = new CognitoIdentityProviderClient({ region: AWS_REGION });
  for (const line of lines) {
    let username: string | undefined;
    try {
      const parsed = JSON.parse(line) as { userPoolId: string; username: string };
      username = parsed.username;
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: parsed.userPoolId, Username: parsed.username }));
    } catch (error) {
      console.warn(`[e2e cleanup] AdminDeleteUser failed for ${username ?? line} (best-effort, not fatal): ${String(error)}`);
    }
  }

  rmSync(MINTED_USERS_FILE, { force: true });
};

// A signed-in account bound to its own golfer record — the ONE identity shape every
// authenticated call in these suites uses (accounts-only identity spec §1-2: every person on
// a card is an account; there are no ghosts and no anonymous rounds). Minted via the admin
// APIs (AdminCreateUser + AdminSetUserPassword, MessageAction SUPPRESS so no email ever
// sends) and exchanged for a real ID token via USER_PASSWORD_AUTH — the beta-grade flow
// enabled exactly so e2e can mint JWTs without driving the Hosted UI — then named once
// through PUT /me. `golferId`/`name` here ARE the account's golfer RECORD — the identity the
// server freezes into the round when this account starts or joins as itself. Accounts-only
// identity (spec §3): StartRound/JoinRound resolve the seat server-side from the Bearer, so the
// call-site bodies carry no name/golferId at all; these fields are only what a story asserts the
// seat SHOULD be, never sent on the wire.
export interface AccountGolfer {
  readonly idToken: string;
  readonly golferId: GolferId;
  readonly name: string;
}

export const mintAccountGolfer = async (httpUrl: string, label: string, name: string): Promise<AccountGolfer> => {
  const { userPoolId, userPoolClientId } = loadCognitoPool();
  const cognito = new CognitoIdentityProviderClient({ region: AWS_REGION });
  const username = `e2e-${label}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}@example.com`;
  const password = `Sw!ng-${Math.random().toString(36).slice(2)}-Aa1`; // meets the pool's default complexity policy

  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: username,
      UserAttributes: [
        { Name: "email", Value: username },
        { Name: "email_verified", Value: "true" },
      ],
      MessageAction: "SUPPRESS",
      TemporaryPassword: password,
    }),
  );
  // Tracked only once the user actually exists — a failed AdminCreateUser throws before this
  // line, so teardown never attempts to delete a user that was never minted.
  trackMintedUser(userPoolId, username);
  // FORCE_CHANGE_PASSWORD -> CONFIRMED, Permanent: true — USER_PASSWORD_AUTH below rejects a
  // still-temporary password with a NEW_PASSWORD_REQUIRED challenge nothing here can answer.
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: username, Password: password, Permanent: true }));

  const auth = await cognito.send(
    new InitiateAuthCommand({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: userPoolClientId, AuthParameters: { USERNAME: username, PASSWORD: password } }),
  );
  const idToken = auth.AuthenticationResult?.IdToken;
  if (!idToken) throw new Error(`InitiateAuth for ${username} returned no IdToken: ${JSON.stringify(auth)}`);

  // PUT /me is the one name-write path (GET /me mints a placeholder-named golfer on first
  // touch; a real name here clears the flag) — the returned record is what the caller's
  // Start/Join bodies source their identity fields from.
  const { golfer } = await put(apiUrl(httpUrl, "/me"), parse(updateMeRequestSchema, { name }), golferResponseSchema, idToken);
  return { idToken, golferId: golfer.golferId, name: golfer.name };
};

// --- Course seeding: search-first, create-if-absent, via the PUBLIC course API ---------------

// Course-cards spec §4: StartRound resolves a REFERENCE now (`{courseId, cardId}`), never a
// card — the caller can no longer author one, so a round-creation body needs a real, seeded
// course lineage to point at. Mirrors apps/web/e2e/support.ts's own ensureCourse exactly
// (search-first by exact name, create-if-absent so a repeat run against the same beta stack
// doesn't mint a duplicate lineage); writes are "golfer"-gated, so the caller passes an already
// signed-in AccountGolfer whose Bearer authorizes the POST.
export const ensureCourse = async (httpUrl: string, name: string, card: CourseCard, account: AccountGolfer): Promise<{ courseId: CourseId; cardId: string }> => {
  if (card.teeSets.length === 0) throw new Error(`course card "${name}" has no tee sets to seed with`);

  const searched = await get(`${apiUrl(httpUrl, "/courses")}?${new URLSearchParams({ query: name }).toString()}`, searchCoursesResponseSchema);
  const existing = searched.courses.find((c) => c.name === name);
  if (existing) {
    const { course } = await get(apiUrl(httpUrl, `/courses/${existing.courseId}`), getCourseResponseSchema);
    return { courseId: course.courseId, cardId: course.cardId };
  }

  const body = parse(createCourseRequestSchema, {
    name,
    teeSets: card.teeSets.map((tee) => ({ name: tee.name, rating: tee.rating, slope: tee.slope, holes: tee.holes })),
  });
  const { course } = await post(apiUrl(httpUrl, "/courses"), body, createCourseResponseSchema, account.idToken);
  return { courseId: course.courseId, cardId: course.cardId };
};

// --- Client-side op identity (deviceId, opId, hlc) ----------------------------------------

export interface ClientOps {
  readonly deviceId: DeviceId;
  next(): { readonly opId: OpId; readonly hlc: Hlc };
}

// One per simulated phone. wallMs tracks real Date.now(), clamped to strictly increase per
// device call — the correction step (brief step 7) needs "a later hlc" than the original
// score, and real elapsed wall-clock time between test steps is what earns that, not an
// artificial counter (domain's state.properties.test.ts already covers the synthetic-tie
// case at the hlc-comparator level; this harness deliberately exercises the real-clock path).
export const createClientOps = (device: string): ClientOps => {
  const id = toDeviceId(device);
  let counter = 0;
  let lastWallMs = 0;
  return {
    deviceId: id,
    next: () => {
      counter += 1;
      lastWallMs = Math.max(Date.now(), lastWallMs + 1);
      return { opId: toOpId(`${device}-op-${counter}`), hlc: { wallMs: lastWallMs, counter: 0, deviceId: id } };
    },
  };
};

// --- WebSocket -----------------------------------------------------------------------------

export interface WsClient {
  readonly envelopes: readonly WsEnvelope[];
  events(): readonly RoundEvent[];
  close(): void;
}

// $connect carries the participant token as a `?token=` query param (lambda/entries/wsConnect.ts),
// not a header.
export const connectWs = async (wsUrl: string, token: string): Promise<WsClient> => {
  const separator = wsUrl.includes("?") ? "&" : "?";
  const socket = new WebSocket(`${wsUrl}${separator}token=${encodeURIComponent(token)}`);
  const envelopes: WsEnvelope[] = [];

  socket.on("message", (data) => {
    // Every WS message parses through wsEnvelopeSchema (this task's brief) — a malformed
    // push fails loudly right here, not as a silently-missing event several steps later.
    envelopes.push(parse(wsEnvelopeSchema, JSON.parse(data.toString())));
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  return {
    envelopes,
    events: () => envelopes.flatMap((envelope) => envelope.events),
    close: () => socket.close(),
  };
};

// --- Poll-with-deadline (never a fixed sleep for "wait until X shows up") ------------------

export const waitFor = async <T>(fn: () => T | undefined, opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {}): Promise<T> => {
  const { timeoutMs = 20_000, intervalMs = 100, label } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = fn();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms${label ? ` (${label})` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

export const waitUntil = (predicate: () => boolean, opts?: { timeoutMs?: number; intervalMs?: number; label?: string }): Promise<void> =>
  waitFor(() => (predicate() ? true : undefined), opts).then(() => undefined);
