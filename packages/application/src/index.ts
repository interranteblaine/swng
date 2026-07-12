// The package's one public interface (conventions §2) — consumers (adapters, lambda,
// their tests) import "@swng/application", never a deep path.

export type { AppendOptions, AppendResult, EventJournal } from "./ports/eventJournal.js";
export type { RoundStore } from "./ports/roundStore.js";
export type { SnapshotStore } from "./ports/snapshotStore.js";
export type { CourseStore } from "./ports/courseStore.js";
export type { CrewStore } from "./ports/crewStore.js";
export type { GolferStore } from "./ports/golferStore.js";
export type { CrewSeasonRecords, ProjectionStore } from "./ports/projectionStore.js";
export type { Broadcast } from "./ports/broadcast.js";
export type { ParticipantClaims, SpectatorClaims, TokenClaims, TokenIssuer } from "./ports/tokenIssuer.js";
export type { AccountClaims } from "./ports/accountClaims.js";
export type { AccountVerifier } from "./ports/accountVerifier.js";
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
export { addParticipant } from "./rounds/addParticipant.js";
export { addGame } from "./rounds/addGame.js";
export { recordScore } from "./rounds/recordScore.js";
export { finalizeRound } from "./rounds/finalizeRound.js";
export { terminateGame } from "./rounds/terminateGame.js";
export { readEvents } from "./rounds/readEvents.js";
export { peekRound } from "./rounds/peekRound.js";
export { getShareLink } from "./rounds/getShareLink.js";
export { resolveSuppliedGolfer } from "./rounds/golferIdentity.js";
export type { GolferIdentityContext } from "./rounds/golferIdentity.js";

export { createCourse } from "./courses/createCourse.js";
export { addTeeSet } from "./courses/addTeeSet.js";
export { verifyTeeSet } from "./courses/verifyTeeSet.js";
export { getCourse } from "./courses/getCourse.js";
export { searchCourses } from "./courses/searchCourses.js";

export { getMyGolfer } from "./golfers/getMyGolfer.js";
export { updateMyGolfer } from "./golfers/updateMyGolfer.js";
export { claimGolfer } from "./golfers/claimGolfer.js";
export { getMyRecord } from "./golfers/getMyRecord.js";

export { createCrew } from "./crews/createCrew.js";
export { getCrew } from "./crews/getCrew.js";
export { listMyCrews } from "./crews/listMyCrews.js";
export { addCrewMember } from "./crews/addCrewMember.js";
export { joinCrewByCode } from "./crews/joinCrewByCode.js";
export { saveStandingGame } from "./crews/saveStandingGame.js";
export { getCrewRecords } from "./crews/getCrewRecords.js";

export { projectArchive, finalizedAtMsOf, seasonOf } from "./projections/projectArchive.js";
export { rebuildProjections } from "./projections/rebuildProjections.js";
export type { ArchiveSource } from "./projections/rebuildProjections.js";

// In-memory ports — exported product surface for lambda/E2E unit tests (M3 Task 4+), not
// just this package's own tests.
export {
  createCapturingBroadcast,
  createFixedClock,
  createInMemoryCourseStore,
  createInMemoryCrewStore,
  createInMemoryGolferStore,
  createInMemoryJournal,
  createInMemoryProjectionStore,
  createInMemoryRoundStore,
  createInMemorySnapshotStore,
  createNullLogger,
  createSequentialIds,
  putAndBindGolfer,
} from "./testing/fakes.js";
export type { CapturingBroadcast, InMemorySnapshotStore } from "./testing/fakes.js";
