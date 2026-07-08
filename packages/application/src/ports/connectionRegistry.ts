import type { RoundId } from "@swng/domain";

// WS delivery infrastructure — consumed by the ws entry points and the API Gateway
// broadcast adapter (M3 Task 4), never by a round use case directly.
export interface ConnectionRegistry {
  register(connectionId: string, roundId: RoundId): Promise<void>;
  deregister(connectionId: string): Promise<void>;
  listByRound(roundId: RoundId): Promise<readonly string[]>;
}
