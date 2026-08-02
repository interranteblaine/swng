// The package's one public interface (conventions §2) — consumers (adapters, lambda,
// their tests) import "@swng/application", never a deep path.

export type { AppendOptions, AppendResult, EventJournal } from "./ports/eventJournal.js";
export type { RoundStore } from "./ports/roundStore.js";
export type { SnapshotStore } from "./ports/snapshotStore.js";
// Course-cards spec: the write-once-lineage store — the M6 CourseStore aggregate it replaced
// is deleted whole (see ports/cardStore.ts's own doc comment).
export type { CardStore } from "./ports/cardStore.js";
export type { CrewSeason, CrewStore } from "./ports/crewStore.js";
export type { GolferStore } from "./ports/golferStore.js";
export type { ProjectionStore } from "./ports/projectionStore.js";
export type { Broadcast } from "./ports/broadcast.js";
export type { CrewInviteClaims, ParticipantClaims, SpectatorClaims, TokenClaims, TokenIssuer } from "./ports/tokenIssuer.js";
export type { AccountClaims } from "./ports/accountClaims.js";
export type { AccountVerifier } from "./ports/accountVerifier.js";
export type { Clock } from "./ports/clock.js";
export type { IdGenerator } from "./ports/idGenerator.js";
export type { Logger } from "./ports/logger.js";
export type { Metrics } from "./ports/metrics.js";
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
export { abandonRound } from "./rounds/abandonRound.js";
export { terminateGame } from "./rounds/terminateGame.js";
export { leaveRound } from "./rounds/leaveRound.js";
// spec 2026-07-30 §2: any participant sets any participant's strokes — one number, no
// self-assertion — shaped like leaveRound's own participant-append.
export { setStrokes } from "./rounds/setStrokes.js";
// spec 2026-08-01 §3b/§4: any participant corrects the round's played date — a round-level fact,
// shaped like setStrokes/leaveRound's own participant-append.
export { setPlayedAt } from "./rounds/setPlayedAt.js";
// spec 2026-08-02 §3b: any participant corrects the holes the round set out to play — a
// round-level fact, shaped exactly like setPlayedAt's own participant-append.
export { setHoles } from "./rounds/setHoles.js";
export { readEvents } from "./rounds/readEvents.js";
export { peekRound } from "./rounds/peekRound.js";
export { getShareLink } from "./rounds/getShareLink.js";
export { getRoundArchive } from "./rounds/getRoundArchive.js";
// Architecture-realignment Task 14: the participant-token re-mint — scoring capability
// derives from participation, not the device that joined.
export { mintParticipantToken } from "./rounds/mintParticipantToken.js";

export { createCourse } from "./courses/createCourse.js";
export { supersedeCard } from "./courses/supersedeCard.js";
export { getCourse } from "./courses/getCourse.js";
export { searchCourses } from "./courses/searchCourses.js";

export { ensureGolfer } from "./golfers/ensureGolfer.js";
export { getMyGolfer } from "./golfers/getMyGolfer.js";
export { updateMyGolfer } from "./golfers/updateMyGolfer.js";
export { getMyRecord } from "./golfers/getMyRecord.js";
// Analytics spec 2026-07-21 §4: GET /me/courses/{courseId}/record — "Your record here."
export { getMyCourseRecord } from "./golfers/getMyCourseRecord.js";
export { getMyRounds } from "./golfers/getMyRounds.js";
export { getMyLiveRounds } from "./golfers/getMyLiveRounds.js";
// Navigation spec §6a: GET /golfers/{golferId} — any signed-in golfer, not self-scoped.
export { getGolfer } from "./golfers/getGolfer.js";

export { createCrew } from "./crews/createCrew.js";
export { getCrew } from "./crews/getCrew.js";
export { listMyCrews } from "./crews/listMyCrews.js";
// Crew membership (invited in, accountable out): addCrewMember/joinCrewByCode and the
// permanent join code they rode are GONE — mintCrewInvite/peekCrewInvite/joinCrewByInvite
// replace the whole "in" surface with expiring, revocation-bounded invite links (spec §2/§3).
export { CREW_INVITE_TTL_MS, mintCrewInvite } from "./crews/mintCrewInvite.js";
export { peekCrewInvite } from "./crews/peekCrewInvite.js";
export { joinCrewByInvite } from "./crews/joinCrewByInvite.js";
export { leaveCrew } from "./crews/leaveCrew.js";
// Crew membership (invited in, accountable out — spec §1): the organizer's authority — remove
// (DELETE /crews/{crewId}/members/{golferId}) and transfer (POST /crews/{crewId}/transfer), both
// organizer-gated (requireCrewMember then a role check → ApplicationError("not-organizer")).
export { removeCrewMember } from "./crews/removeCrewMember.js";
export { transferOrganizer } from "./crews/transferOrganizer.js";
export { createSeason } from "./crews/createSeason.js";
export { listSeasons } from "./crews/listSeasons.js";
// Spec 2026-07-22 "the season is the record": editing the end date IS the whole lifecycle —
// updateSeason replaces close/reopen outright (there is no closed state left to gate on).
export { updateSeason } from "./crews/updateSeason.js";
// The crew name is editable too (spec §2), organizer-only, no season lookup.
export { updateCrew } from "./crews/updateCrew.js";
export { getSeasonStandings } from "./crews/getSeasonStandings.js";

export { projectArchive, finalizedAtMsOf } from "./projections/projectArchive.js";
export { rebuildProjections } from "./projections/rebuildProjections.js";

// In-memory ports — exported product surface for lambda/E2E unit tests (M3 Task 4+), not
// just this package's own tests.
export {
  createCapturingBroadcast,
  createCapturingLogger,
  createFixedClock,
  createInMemoryCardStore,
  createInMemoryCrewStore,
  createInMemoryGolferStore,
  createInMemoryJournal,
  createInMemoryProjectionStore,
  createInMemoryRoundStore,
  createInMemorySnapshotStore,
  createNullLogger,
  createNullMetrics,
  createCapturingMetrics,
  createSequentialIds,
  createTestTokenIssuer,
  putAndBindGolfer,
  seedCard,
} from "./testing/fakes.js";
export type { CapturingBroadcast, CapturingLogger, CapturingMetrics, InMemorySnapshotStore } from "./testing/fakes.js";
