import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CreateTableCommand, DynamoDBClient, ListTablesCommand, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Contract-test-only infrastructure (M3 plan, Global Constraints): boots a real DynamoDB
// Local JVM so the journal/store/registry adapters are proven against the actual service,
// not a mock of it. Never imported by product code — `pnpm validate` stays hermetic because
// nothing under src/contract runs by default (see vitest.config.ts) and this module is
// excluded from the build (tsconfig.build.json).

const execFileAsync = promisify(execFile);

const DOWNLOAD_URL = "https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz";
const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

// packages/adapters-dynamodb — two levels up from this file (src/testing/local.ts).
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const cacheDir = path.join(packageRoot, "node_modules", ".cache", "dynamodb-local");
const jarPath = path.join(cacheDir, "DynamoDBLocal.jar");
const libDir = path.join(cacheDir, "DynamoDBLocal_lib");

export interface LocalDynamo {
  readonly client: DynamoDBDocumentClient;
  readonly roundsTable: string;
  readonly connectionsTable: string;
  readonly coreTable: string;
  readonly projectionsTable: string;
  readonly snapshotsTable: string;
  readonly stop: () => Promise<void>;
}

const ensureJavaAvailable = async (): Promise<void> => {
  try {
    await execFileAsync("java", ["-version"]);
  } catch (error) {
    throw new Error(
      "DynamoDB Local requires a `java` binary on PATH (Java 21+), but `java -version` failed. " +
        "Install Java or run the contract suite where it's available — this is a hard failure, not a skip.",
      { cause: error },
    );
  }
};

// Contract test files each boot their own DynamoDB Local (separate vitest worker
// processes), so a cold cache is downloaded/extracted by more than one process at once.
// Stage into a private per-process directory and atomically rename it into place — a
// sibling process can then never spawn java against a jar this process is still mid-write
// on, and `fs.rename` onto an existing non-empty `cacheDir` fails cleanly (ENOTEMPTY),
// which just means a sibling already won; its result is used instead.
const ensureJar = async (): Promise<void> => {
  if (existsSync(jarPath)) return;

  await ensureJavaAvailable();
  await fs.mkdir(path.dirname(cacheDir), { recursive: true });
  const stagingDir = `${cacheDir}.staging-${process.pid}-${randomUUID()}`;
  await fs.mkdir(stagingDir, { recursive: true });

  try {
    const tarPath = path.join(stagingDir, "dynamodb-local.tar.gz");

    try {
      const response = await fetch(DOWNLOAD_URL);
      if (!response.ok) {
        throw new Error(`unexpected response ${response.status} ${response.statusText}`);
      }
      // A one-time ~50MB fetch (M3 plan) — buffering it whole avoids reconciling the DOM
      // vs. node:stream/web ReadableStream types, and this never runs on a hot path.
      await fs.writeFile(tarPath, Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      throw new Error(`Failed to download DynamoDB Local from ${DOWNLOAD_URL}: ${(error as Error).message}`, { cause: error });
    }

    try {
      await execFileAsync("tar", ["-xzf", tarPath, "-C", stagingDir]);
    } catch (error) {
      throw new Error(`Failed to extract DynamoDB Local archive at ${tarPath}: ${(error as Error).message}`, { cause: error });
    } finally {
      await fs.rm(tarPath, { force: true });
    }

    if (!existsSync(path.join(stagingDir, "DynamoDBLocal.jar"))) {
      throw new Error(`DynamoDB Local archive extracted into ${stagingDir}, but DynamoDBLocal.jar is missing — unexpected archive layout.`);
    }

    if (existsSync(jarPath)) return; // a sibling process already won the race

    try {
      await fs.rename(stagingDir, cacheDir);
    } catch (error) {
      if (!existsSync(jarPath)) throw error; // genuine failure, not just losing the race
    }
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
};

const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("could not determine a free port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });

const waitUntilReachable = async (dynamo: DynamoDBClient, isAlive: () => boolean, diagnostics: () => string): Promise<void> => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (!isAlive()) throw new Error(`DynamoDB Local exited before becoming reachable.\n${diagnostics()}`);
    try {
      await dynamo.send(new ListTablesCommand({}));
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`DynamoDB Local did not become reachable within ${READY_TIMEOUT_MS}ms.\n${diagnostics()}`);
      }
      await sleep(200);
    }
  }
};

const createTables = async (
  dynamo: DynamoDBClient,
  roundsTable: string,
  connectionsTable: string,
  coreTable: string,
  projectionsTable: string,
  snapshotsTable: string,
): Promise<void> => {
  // Rounds table (M3 plan, Global Constraints): pk `ROUND#<id>` / sk `EVT#<seq>` | META |
  // ARCHIVE | `OPID#<opId>`; gsi1 on `joinCode` (META items only).
  await dynamo.send(
    new CreateTableCommand({
      TableName: roundsTable,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
        { AttributeName: "joinCode", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        { IndexName: "gsi1", KeySchema: [{ AttributeName: "joinCode", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } },
      ],
    }),
  );

  // Connections table: pk `CONN#<connectionId>` with attribute `roundId`; gsi1 on `roundId`.
  await dynamo.send(
    new CreateTableCommand({
      TableName: connectionsTable,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "roundId", AttributeType: "S" },
      ],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        { IndexName: "gsi1", KeySchema: [{ AttributeName: "roundId", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } },
      ],
    }),
  );

  // Core table (M6 Task 3, mirroring apps/infra-cdk/lib/swngStack.ts's real CoreTable): pk
  // `COURSE#<id>` / sk `COURSE`; gsi1 is the single-partition course-name search index
  // (gsi1pk fixed to one constant, gsi1sk the normalized name — see keys.ts), projecting
  // only `name` so the contract suite can prove search never leaks the full course document
  // over the wire, not just that the adapter code happens not to read it.
  // gsi2 (M7 Task 3) is the sub→golfer lookup getBySub queries: pk `GOLFER#<id>` / sk `GOLFER`
  // golfer items (keys.ts's golferPk/golferSk) additionally carry gsi2pk/gsi2sk once claimed.
  // ProjectionType ALL — golfer items are small (a name, a couple of handicap numbers), so
  // there's no reason to pay INCLUDE's bookkeeping cost the way gsi1 does for the much larger
  // course document. The real CDK gsi2 construct is Task 4's job (CLAUDE.md/the task brief);
  // this is the local contract harness's own table definition only.
  await dynamo.send(
    new CreateTableCommand({
      TableName: coreTable,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
        { AttributeName: "gsi1pk", AttributeType: "S" },
        { AttributeName: "gsi1sk", AttributeType: "S" },
        { AttributeName: "gsi2pk", AttributeType: "S" },
        { AttributeName: "gsi2sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "gsi1",
          KeySchema: [
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["name"] },
        },
        {
          IndexName: "gsi2",
          KeySchema: [
            { AttributeName: "gsi2pk", KeyType: "HASH" },
            { AttributeName: "gsi2sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );

  // Projections table (M7 Task 3; keys stabilized in the projection-realignment, spec §3): one
  // partition per golfer (pk `GOLFER#<id>`), holding `ROUND#<roundId>` lines, one `INDEX`
  // snapshot, and `LIVE#<roundId>` presence rows (keys.ts). No GSI — every access pattern
  // (upsert/list a golfer's own lines, get/put/wipe their index, presence put/list/delete) is a
  // base-table op on this one partition key.
  await dynamo.send(
    new CreateTableCommand({
      TableName: projectionsTable,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    }),
  );

  // Snapshots table (projection-realignment spec §1/§11, mirroring swngStack.ts's real
  // SnapshotsTable): pk-only (the bare roundId — keys.ts's snapshotPk), no sk (time is the
  // `finalizedAt` attribute, never a sort key), no GSI. "The atom": one immutable item per
  // finalized round, written only by the atomic finalize transaction.
  await dynamo.send(
    new CreateTableCommand({
      TableName: snapshotsTable,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
    }),
  );

  await Promise.all([
    waitUntilTableExists({ client: dynamo, maxWaitTime: 30 }, { TableName: roundsTable }),
    waitUntilTableExists({ client: dynamo, maxWaitTime: 30 }, { TableName: connectionsTable }),
    waitUntilTableExists({ client: dynamo, maxWaitTime: 30 }, { TableName: coreTable }),
    waitUntilTableExists({ client: dynamo, maxWaitTime: 30 }, { TableName: projectionsTable }),
    waitUntilTableExists({ client: dynamo, maxWaitTime: 30 }, { TableName: snapshotsTable }),
  ]);
};

// Downloads DynamoDB Local if absent, boots it in-memory on a free port, creates the
// `rounds` + `connections` + `core` + `projections` + `snapshots` tables, and returns a
// ready-to-use document client plus a `stop` that tears the JVM down. Any failure along the way (no java,
// download/extract failure, the process never becoming reachable) throws — the contract suite
// must fail loudly, never silently skip.
export const startLocalDynamo = async (): Promise<LocalDynamo> => {
  await ensureJar();

  const port = await findFreePort();
  const proc = spawn("java", [`-Djava.library.path=${libDir}`, "-jar", jarPath, "-inMemory", "-port", String(port)], {
    cwd: cacheDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let exited = false;
  proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  proc.on("exit", () => (exited = true));
  proc.on("error", () => (exited = true));
  const diagnostics = () => `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;

  const dynamo = new DynamoDBClient({
    endpoint: `http://127.0.0.1:${port}`,
    region: "local",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });

  try {
    await waitUntilReachable(dynamo, () => !exited, diagnostics);

    const roundsTable = "rounds";
    const connectionsTable = "connections";
    const coreTable = "core";
    const projectionsTable = "projections";
    const snapshotsTable = "snapshots";
    await createTables(dynamo, roundsTable, connectionsTable, coreTable, projectionsTable, snapshotsTable);

    const client = DynamoDBDocumentClient.from(dynamo);

    const stop = async (): Promise<void> => {
      client.destroy();
      if (exited) return;
      const forceKill = new AbortController();
      await new Promise<void>((resolve) => {
        proc.once("exit", () => {
          forceKill.abort();
          resolve();
        });
        proc.kill("SIGTERM");
        // In-memory Local should exit promptly on SIGTERM; force it if it doesn't. The
        // abort on exit above cancels this timer so `stop()` never holds the process open
        // for the full STOP_TIMEOUT_MS on the (normal) prompt-exit path.
        sleep(STOP_TIMEOUT_MS, undefined, { signal: forceKill.signal })
          .then(() => proc.kill("SIGKILL"))
          .catch(() => {});
      });
    };

    return { client, roundsTable, connectionsTable, coreTable, projectionsTable, snapshotsTable, stop };
  } catch (error) {
    proc.kill("SIGKILL");
    dynamo.destroy();
    throw error;
  }
};
