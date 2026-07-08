// The package's one public interface (conventions §2) — consumers (adapters, lambda,
// their tests) import "@swng/application", never a deep path.

export type { AppendResult, EventJournal } from "./ports/eventJournal.js";
export type { RoundStore } from "./ports/roundStore.js";
export type { Broadcast } from "./ports/broadcast.js";
export type { ParticipantClaims, TokenIssuer } from "./ports/tokenIssuer.js";
export type { Clock } from "./ports/clock.js";
export type { IdGenerator } from "./ports/idGenerator.js";
export type { Logger } from "./ports/logger.js";
export type { ConnectionRegistry } from "./ports/connectionRegistry.js";

export { ApplicationError } from "./errors.js";
export type { ApplicationErrorCode } from "./errors.js";

export { mayScore } from "./scoringPolicy.js";
export type { ScoringPolicy } from "./scoringPolicy.js";

export { startRound } from "./rounds/startRound.js";
export { joinRound } from "./rounds/joinRound.js";
export { addGame } from "./rounds/addGame.js";
export { recordScore } from "./rounds/recordScore.js";
export { finalizeRound } from "./rounds/finalizeRound.js";
export { readEvents } from "./rounds/readEvents.js";

// In-memory ports — exported product surface for lambda/E2E unit tests (M3 Task 4+), not
// just this package's own tests.
export {
  createCapturingBroadcast,
  createFixedClock,
  createInMemoryJournal,
  createInMemoryRoundStore,
  createNullLogger,
  createSequentialIds,
} from "./testing/fakes.js";
export type { CapturingBroadcast } from "./testing/fakes.js";
