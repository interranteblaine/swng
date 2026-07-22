import type { Crew, CrewId, GolferId, RoundId } from "@swng/domain";

// Crew seasons (architecture-realignment task-8-brief.md §4; the counting apparatus this
// comment used to describe (a season's own stored, appendable, removable ledger of counted
// rounds) is deleted whole, crew-scoreboard spec §2b: standings are computed on read over a
// window instead, never a stored ledger). A crew defines its own seasons
// as named time windows on its own side only — a round itself records no crewId/seasonId
// back-reference (round-is-a-sealed-leaf, the realignment's own correction to M8's
// crewId-on-round weld). `seasonId` is minted by CALLERS (Task 9's create-season use case, via
// IdGenerator.newId()) — this store treats it as an opaque string.
export interface CrewSeason {
  // CALLER CONTRACT: seasonId is an opaque server-minted id (IdGenerator.newId() → UUID) and
  // MUST NEVER contain the "#" character. The store's key vocabulary composites seasonId
  // between "#" separators: seasonSk(seasonId) = "SEASON#<seasonId>". Orphaned legacy
  // "SEASON#<seasonId>#ROUND#<roundId>" items — written by the now-deleted counting
  // apparatus — share this prefix on purpose (createDynamoCrewStore.ts's own comment) and are
  // tolerated forever, filtered out of listSeasons client-side (the standingGame precedent) —
  // never a migration. The guard in putSeason below still enforces no "#" in a caller's
  // seasonId, since the shared prefix scheme itself is unchanged.
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

  // Seasons (task-8-brief.md). Entity data about the crew, stored under the
  // crew's own key space (not a projection, not event-sourced) — a season is created, renamed,
  // or closed via the SAME upsert-by-seasonId put; there is no separate create-vs-update call,
  // and no revision to conflict on (whichever CrewSeason a caller supplies wins outright,
  // unlike put's own expectedRevision-conditional crew replace above).
  putSeason(crewId: CrewId, season: CrewSeason): Promise<void>;
  getSeason(crewId: CrewId, seasonId: string): Promise<CrewSeason | undefined>;
  // NO ORDER PROMISED (mirrors ProjectionStore.listLines' own doc-comment idiom) — callers sort
  // by `createdAtMs`/`name` themselves. Orphaned legacy counted-round entries filed under any of
  // this crew's seasons (the now-deleted counting apparatus' own item shape) are excluded from
  // the result (see createDynamoCrewStore's own comment for why: one Query serves both item
  // kinds under a shared key prefix, filtered client-side — the standingGame tolerate-forever
  // precedent, never a migration).
  listSeasons(crewId: CrewId): Promise<readonly CrewSeason[]>;

  // True iff roundId is counted in ANY season of this crew (not scoped to one season). Kept
  // for legacy orphaned counted-round data (see listSeasons above) even though nothing writes
  // new entries anymore — the counting apparatus that used to populate this is deleted whole
  // (crew-scoreboard spec §2b).
  countsRound(crewId: CrewId, roundId: RoundId): Promise<boolean>;
}
