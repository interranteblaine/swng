import type { CrewId, CrewRoundContribution, GolferId, GolferRoundLine, HeadToHeadRecord, RoundId, SeasonLedgerLine } from "@swng/domain";

// DELETED IN REALIGNMENT TASK 9, alongside the crew section of ProjectionStore below (spec §4/
// §9: crew standings become computed-on-read over the snapshots table, stored nowhere). Kept
// UNCHANGED for this task only so the still-live crew routes don't wedge mid-realignment.
export interface CrewSeasonRecords {
  readonly ledger: readonly SeasonLedgerLine[];
  readonly headToHead: readonly HeadToHeadRecord[];
}

// The golfer record + presence surface (projection-realignment spec §3/§5) — the projections
// table's one golfer partition (adapters-dynamodb's golferPk): a `ROUND#<roundId>` line per
// finalized round the golfer played, one `INDEX` snapshot, and `LIVE#<roundId>` presence rows.
//
// KEYS ARE IDENTITIES, TIME IS AN ATTRIBUTE (spec §0/§3): putLine's key is `roundId` alone —
// never finalizedAtMs — so a reopen-and-refinalize (a NEW round-finalized event, a DIFFERENT
// finalizedAtMs, the SAME roundId) computes the SAME key both times and a plain unconditional
// write replaces the prior line outright. This is the fix for the OLD scheme's own documented,
// unrepairable bug (M8/M9's `putHistoryLine`/`putCrewRound`): a time-embedded sort key turned
// that same correction into query-then-delete-then-put, and for the crew ledger's season-scoped
// version of the same idiom, a stale entry that could silently survive forever across a UTC-year
// boundary. There is no equivalent bug possible here — there is no second key to strand data
// under.
//
// listLines is UNORDERED (createDynamoProjectionStore.ts's Query no longer sorts by time — the
// sk carries no time to sort by) — every caller (projectArchive's index fold, getMyRecord's wire
// response) sorts by the `finalizedAtMs` each line carries itself, at read time, over what is
// always a small, whole-career result set. This is deliberate, not a gap: the alternative
// (embedding order in the key) is exactly the bug this rewrite removes.
export interface ProjectionStore {
  putLine(golferId: GolferId, line: GolferRoundLine & { readonly finalizedAtMs: number }): Promise<void>;
  listLines(golferId: GolferId): Promise<readonly (GolferRoundLine & { readonly finalizedAtMs: number })[]>;
  putIndex(golferId: GolferId, snapshot: { readonly value: number; readonly computedAtMs: number; readonly differentialsUsed: number }): Promise<void>;
  getIndex(golferId: GolferId): Promise<{ value: number; computedAtMs: number; differentialsUsed: number } | undefined>;

  // Presence (spec §5). Implemented here — ahead of any real writer — so the store's shape
  // rewrites exactly once rather than growing a second time when realignment Task 13 (the
  // StartRound/JoinRound/AddParticipant writers + "Your rounds" home read) and Task 15 (the
  // finalize-time deleteLive call) land. `expiresAtSec` is epoch SECONDS — DynamoDB TTL's own
  // unit, unlike every other timestamp in this codebase (milliseconds) — and the adapter writes
  // it into the item's `ttl` attribute, the one the projections table's TTL spec already names
  // (apps/infra-cdk/lib/swngStack.ts, realignment Task 1).
  putLive(golferId: GolferId, entry: { readonly roundId: RoundId; readonly courseName: string; readonly joinedAtMs: number; readonly expiresAtSec: number }): Promise<void>;
  deleteLive(golferId: GolferId, roundId: RoundId): Promise<void>;
  listLive(golferId: GolferId): Promise<readonly { roundId: RoundId; courseName: string; joinedAtMs: number }[]>;

  // DELETED IN REALIGNMENT TASK 5: the buffered, globally-sorted, wipe-then-replay rebuild this
  // exists for dies with it (spec §9) — the paged backfill Task 5 ships instead never wipes
  // anything (every write here is already an idempotent upsert/replace, so replaying a snapshot
  // twice reproduces identical state with no wipe step required). Kept here, unchanged, only
  // because rebuildProjections.ts still calls it as of this task.
  wipeGolfer(golferId: GolferId): Promise<void>;

  // Upsert by (crewId, roundId) via entry.roundId — a repeat put for the same round replaces,
  // never accumulates.
  /** deleted in realignment Task 9 */
  putCrewRound(crewId: CrewId, season: number, entry: CrewRoundContribution & { readonly finalizedAtMs: number }): Promise<void>;
  /** deleted in realignment Task 9 */
  listCrewRounds(crewId: CrewId, season: number): Promise<readonly (CrewRoundContribution & { readonly finalizedAtMs: number })[]>;
  /** deleted in realignment Task 9 */
  putSeasonRecords(crewId: CrewId, season: number, records: CrewSeasonRecords): Promise<void>;
  /** deleted in realignment Task 9 */
  getSeasonRecords(crewId: CrewId, season: number): Promise<CrewSeasonRecords | undefined>;
  // rebuildProjections' first step for every crew TOUCHED by the archive set (mirrors
  // wipeGolfer above) — `seasons` is supplied by the caller, so this store never has to
  // discover its own keyspace.
  /** deleted in realignment Task 9 */
  wipeCrew(crewId: CrewId, seasons: readonly number[]): Promise<void>;
}
