import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { z } from "zod";
import { parse, wsEnvelopeSchema } from "@swng/contracts";
import type { WsEnvelope } from "@swng/contracts";
import type { DeviceId, Hlc, OpId, RoundEvent } from "@swng/domain";
import { deviceId as toDeviceId, opId as toOpId } from "@swng/domain";

// --- Endpoints ---------------------------------------------------------------------------

export interface Endpoints {
  readonly httpUrl: string;
  readonly wsUrl: string;
}

// E2E_HTTP_URL / E2E_WS_URL win when both are set; otherwise fall back to whatever
// `cdk deploy` last wrote to apps/infra-cdk/cdk-outputs.json (gitignored — one entry keyed
// by stack name, e.g. "swng-beta").
export const loadEndpoints = (): Endpoints => {
  const envHttp = process.env["E2E_HTTP_URL"];
  const envWs = process.env["E2E_WS_URL"];
  if (envHttp && envWs) return { httpUrl: envHttp, wsUrl: envWs };

  const outputsPath = fileURLToPath(new URL("../../apps/infra-cdk/cdk-outputs.json", import.meta.url));
  let outputs: Record<string, { HttpApiUrl: string; WsApiUrl: string }>;
  try {
    outputs = JSON.parse(readFileSync(outputsPath, "utf8")) as Record<string, { HttpApiUrl: string; WsApiUrl: string }>;
  } catch (error) {
    throw new Error(
      `E2E_HTTP_URL/E2E_WS_URL are unset and ${outputsPath} could not be read (run \`pnpm deploy:beta\` first, or set both env vars): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const [stackOutputs] = Object.values(outputs);
  if (!stackOutputs) throw new Error(`no stack outputs found in ${outputsPath}`);

  return { httpUrl: envHttp ?? stackOutputs.HttpApiUrl, wsUrl: envWs ?? stackOutputs.WsApiUrl };
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
