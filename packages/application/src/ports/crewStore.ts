import type { Crew, CrewId, GolferId, RoundId } from "@swng/domain";

// Crew seasons + counted rounds (architecture-realignment task-8-brief.md §4): a crew defines
// its own seasons and counts FINISHED rounds into them by roundId, on the crew's side only —
// a round itself records no crewId/seasonId back-reference (round-is-a-sealed-leaf, the
// realignment's own correction to M8's crewId-on-round weld). `seasonId` is minted by CALLERS
// (Task 9's create-season use case, via IdGenerator.newId()) — this store treats it as an
// opaque string.
export interface CrewSeason {
  // CALLER CONTRACT: seasonId is an opaque server-minted id (IdGenerator.newId() → UUID) and
  // MUST NEVER contain the "#" character. The store's key vocabulary composites seasonId
  // between "#" separators: seasonSk(seasonId) = "SEASON#<seasonId>" and
  // countedRoundSk(seasonId, roundId) = "SEASON#<seasonId>#ROUND#<roundId>". A "#" in
  // seasonId would create a key collision between season items and counted-round items,
  // breaking listSeasons' ability to filter them apart. Guards in putSeason/addCountedRound
  // enforce this invariant at the store level.
  readonly seasonId: string;
  readonly name: string;
  readonly status: "open" | "closed";
  readonly createdAtMs: number;
  // Window bounds (crew-scoreboard spec §2): a round is IN this season iff its played date
  // falls in [startsAtMs, closedAtMs ?? ∞]. startsAtMs is fixed at creation (seasonStart.ts's
  // own `seasonStartMs` — the tiling start rule) and never recomputed. closedAtMs is set by
  // closeSeason and DELETED by reopenSeason (a season's own re-open is lossless by
  // construction — putSeason below is a whole-item put, so an absent closedAtMs on a caller's
  // CrewSeason truly removes it from storage, not just from this in-memory value).
  readonly startsAtMs: number;
  readonly closedAtMs?: number;
}

// One finished round counted into a season — entity data ABOUT the crew (the crew's own
// pointer TO a round), never the reverse.
export interface CountedRound {
  readonly roundId: RoundId;
  readonly finalizedAtMs: number;
  readonly appendedBy: GolferId;
  readonly appendedAtMs: number;
}

// A crew's persistence, mirroring CourseStore/GolferStore's revision-conditional CRUD
// contract (both port docs' precedent) — a Crew is a plain entity, not event-sourced
// (crew/crew.ts's own doc comment), so this is get/put over the whole aggregate.
//
// Crew membership (invited in, accountable out): the permanent join code — and the
// store-level `joinCode` metadata that used to ride every put/get here, mirroring
// RoundStore's own join-code split — is GONE. Getting in is by expiring HMAC invite link now
// (crews/mintCrewInvite.ts/joinCrewByInvite.ts), a stateless TokenIssuer claim, never a
// store-resident lookup value, so this store carries nothing invite-shaped at all anymore.
export interface CrewStore {
  // expectedRevision undefined ⇒ create (condition: item absent); n ⇒ replace revision n
  // (condition: stored revision === n). On condition failure throws the application-layer
  // error idiom (errors.ts) with code "crew-conflict".
  put(crew: Crew, expectedRevision: number | undefined): Promise<void>;
  get(crewId: CrewId): Promise<{ crew: Crew; revision: number } | undefined>;
  // Crews a golfer belongs to, summarized for a roster screen — not the full Crew (that's
  // GetCrew's job once a specific crew is picked).
  listByGolfer(golferId: GolferId): Promise<readonly { crewId: CrewId; name: string; memberCount: number }[]>;

  // Seasons + counted rounds (task-8-brief.md). Entity data about the crew, stored under the
  // crew's own key space (not a projection, not event-sourced) — a season is created, renamed,
  // or closed via the SAME upsert-by-seasonId put; there is no separate create-vs-update call,
  // and no revision to conflict on (whichever CrewSeason a caller supplies wins outright,
  // unlike put's own expectedRevision-conditional crew replace above).
  putSeason(crewId: CrewId, season: CrewSeason): Promise<void>;
  getSeason(crewId: CrewId, seasonId: string): Promise<CrewSeason | undefined>;
  // NO ORDER PROMISED (mirrors ProjectionStore.listLines' own doc-comment idiom) — callers sort
  // by `createdAtMs`/`name` themselves. Counted-round entries filed under any of this crew's
  // seasons are excluded from the result (see createDynamoCrewStore's own comment for why: one
  // Query serves both item kinds under a shared key prefix, filtered client-side).
  listSeasons(crewId: CrewId): Promise<readonly CrewSeason[]>;

  // Appends one counted round to a season. Collision — the SAME roundId already counted in
  // THIS season — throws ApplicationError("round-already-counted"); this is only the
  // storage-level dedupe, WHO may append is a Task 9 use-case concern. The SAME roundId counted
  // in a DIFFERENT season of the same crew is allowed and entirely independent — each season is
  // its own lens over a crew's rounds, never a global crew-wide set.
  addCountedRound(crewId: CrewId, seasonId: string, entry: CountedRound): Promise<void>;
  // A plain delete — removing an entry that was never there (or was already removed) is a
  // no-op, not an error. WHO may remove is Task 9's concern, not this store's.
  removeCountedRound(crewId: CrewId, seasonId: string, roundId: RoundId): Promise<void>;
  // NO ORDER PROMISED, same as listSeasons above — callers sort by `finalizedAtMs` themselves.
  listCountedRounds(crewId: CrewId, seasonId: string): Promise<readonly CountedRound[]>;
  // True iff roundId is counted in ANY season of this crew (not scoped to one season).
  countsRound(crewId: CrewId, roundId: RoundId): Promise<boolean>;
}
