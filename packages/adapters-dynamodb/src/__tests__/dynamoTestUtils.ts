/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type {
  RoundConfig,
  RoundState,
  Player,
  Score,
  IsoDateTime,
} from "@swng/domain";
import type { Session, Connection } from "@swng/application";

/**
 * Minimal in-memory DynamoDB DocumentClient fake focused on behavior under test.
 * - Keyed by TableName + PK + SK
 * - Supports Get, Put (with simple conditions), Delete, Query (by PK and SK prefix)
 * - Supports GSI1 lookups used by getRoundSnapshotByAccessCode
 */
export function createDocClientFake(): DynamoDBDocumentClient {
  type Key = string; // `${PK}|${SK}`
  const tables = new Map<string, Map<Key, any>>();

  function ensureTable(tableName: string) {
    let table = tables.get(tableName);
    if (!table) {
      table = new Map();
      tables.set(tableName, table);
    }
    return table;
  }

  function makeKey(pk: string, sk: string): Key {
    return `${pk}|${sk}`;
  }

  function getItem(tableName: string, pk: string, sk: string) {
    const table = ensureTable(tableName);
    return table.get(makeKey(pk, sk));
  }

  function putItem(tableName: string, item: any) {
    const table = ensureTable(tableName);
    table.set(makeKey(item.PK, item.SK), item);
  }

  function deleteItem(tableName: string, pk: string, sk: string) {
    const table = ensureTable(tableName);
    table.delete(makeKey(pk, sk));
  }

  async function send(cmd: any): Promise<any> {
    // GET
    if (cmd instanceof GetCommand) {
      const { TableName, Key } = (cmd as any).input;
      const found = getItem(TableName, Key.PK, Key.SK);
      return found ? { Item: found } : {};
    }

    // PUT
    if (cmd instanceof PutCommand) {
      const {
        TableName,
        Item,
        ConditionExpression,
        ExpressionAttributeValues,
      } = (cmd as any).input;

      const existing = getItem(TableName, Item.PK, Item.SK);

      // Handle simple condition patterns used by our repositories
      if (ConditionExpression) {
        const expr = String(ConditionExpression);

        // attribute_not_exists(PK) AND attribute_not_exists(SK)
        if (
          expr.includes("attribute_not_exists(PK)") &&
          expr.includes("attribute_not_exists(SK)")
        ) {
          if (existing) {
            throw new ConditionalCheckFailedException({} as any);
          }
        }
        // attribute_not_exists(PK) (used by initial state write)
        else if (expr.includes("attribute_not_exists(PK)")) {
          if (existing) {
            throw new ConditionalCheckFailedException({} as any);
          }
        }
        // stateVersion = :prevVersion (optimistic concurrency on state)
        else if (expr.includes("stateVersion = :prevVersion")) {
          const prev = ExpressionAttributeValues?.[":prevVersion"];
          const current = existing?.stateVersion;
          if (existing == null || current !== prev) {
            throw new ConditionalCheckFailedException({} as any);
          }
        }
        // Any other condition expression is out of scope; assume pass
      }

      putItem(TableName, Item);
      return {};
    }

    // DELETE
    if (cmd instanceof DeleteCommand) {
      const { TableName, Key } = (cmd as any).input;
      deleteItem(TableName, Key.PK, Key.SK);
      return {};
    }

    // QUERY
    if (cmd instanceof QueryCommand) {
      const {
        TableName,
        IndexName,
        KeyConditionExpression,
        ExpressionAttributeValues,
        Limit,
      } = (cmd as any).input;

      const table = ensureTable(TableName);
      let items = Array.from(table.values());

      // GSI1 query: "GSI1PK = :gpk"
      if (IndexName) {
        if (String(KeyConditionExpression).includes("GSI1PK = :gpk")) {
          const gpk = ExpressionAttributeValues?.[":gpk"];
          items = items.filter((it) => it.GSI1PK === gpk);
        }
      } else {
        // Base table queries:
        // "PK = :pk" [AND begins_with(SK, :skPrefix)]
        const hasPkEq =
          KeyConditionExpression &&
          String(KeyConditionExpression).includes("PK = :pk");
        const hasBeginsWith =
          KeyConditionExpression &&
          String(KeyConditionExpression).includes("begins_with(SK, :skPrefix)");

        if (hasPkEq) {
          const pk = ExpressionAttributeValues?.[":pk"];
          items = items.filter((it) => it.PK === pk);
        }
        if (hasBeginsWith) {
          const skPrefix = ExpressionAttributeValues?.[":skPrefix"];
          items = items.filter(
            (it) => typeof it.SK === "string" && it.SK.startsWith(skPrefix)
          );
        }
      }

      const limited = typeof Limit === "number" ? items.slice(0, Limit) : items;
      return { Items: limited };
    }

    throw new Error("Unsupported command in fake docClient");
  }

  // Structural typing: this is sufficient for the repositories
  return { send } as unknown as DynamoDBDocumentClient;
}

export function newTestConfig(docClient = createDocClientFake()) {
  return { tableName: "TestTable", docClient };
}

export const NOW: IsoDateTime = "2025-01-01T00:00:00.000Z";
export const LATER: IsoDateTime = "2025-01-01T00:00:01.000Z";

export function sampleRoundConfig(
  overrides: Partial<RoundConfig> = {}
): RoundConfig {
  return {
    roundId: "rid-1",
    accessCode: "code-1",
    courseName: "Course",
    holes: 3,
    par: [3, 4, 5],
    createdAt: NOW,
    ...overrides,
  };
}

export function sampleRoundState(
  overrides: Partial<RoundState> = {}
): RoundState {
  return {
    roundId: "rid-1",
    status: null,
    stateVersion: 1,
    updatedAt: NOW,
    ...overrides,
  };
}

export function samplePlayer(overrides: Partial<Player> = {}): Player {
  return {
    roundId: "rid-1",
    playerId: "pid-1",
    name: "Alice",
    color: "#000000",
    joinedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function sampleScore(overrides: Partial<Score> = {}): Score {
  return {
    roundId: "rid-1",
    playerId: "pid-1",
    holeNumber: 1,
    strokes: 3,
    updatedBy: "pid-1",
    updatedAt: NOW,
    ...overrides,
  };
}

export function sampleSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: "sid-1",
    roundId: "rid-1",
    playerId: "pid-1",
    expiresAt: LATER,
    ...overrides,
  };
}

export function sampleConnection(
  overrides: Partial<Connection> = {}
): Connection {
  return {
    roundId: "rid-1",
    connectionId: "cid-1",
    playerId: "pid-1",
    connectedAt: NOW,
    ...overrides,
  };
}
