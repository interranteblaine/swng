import type { GolferId, GolferRoundLine, RoundId } from "@swng/domain";

// The golfer record + presence surface (projection-realignment spec §3/§5) — the projections
// table's one golfer partition (adapters-dynamodb's golferPk): a `ROUND#<roundId>` line per
// finalized round the golfer played, and `LIVE#<roundId>` presence rows. There is no stored
// index snapshot (pre-prod hardening D4a): the handicap index is computed at read time from
// these same lines (golfers/getMyRecord.ts), never written here — the projector's own
// read-modify-write aggregate, and the cross-shard race it could lose, are both deleted with it.
//
// KEYS ARE IDENTITIES, TIME IS AN ATTRIBUTE (spec §0/§3): putLine's key is `roundId` alone —
// never finalizedAtMs — so a reopen-and-refinalize (a NEW round-finalized event, a DIFFERENT
// finalizedAtMs, the SAME roundId) computes the SAME key both times and a plain unconditional
// write replaces the prior line outright. This is the fix for the OLD scheme's own documented,
// unrepairable bug (M8/M9's time-embedded `putHistoryLine` and the old crew-round-contribution
// writes): a time-embedded sort key turned that same correction into query-then-delete-then-put,
// and for the crew ledger's season-scoped version of the same idiom, a stale entry that could
// silently survive forever across a UTC-year boundary. There is no equivalent bug possible here —
// there is no second key to strand data under.
//
// listLines is UNORDERED (createDynamoProjectionStore.ts's Query no longer sorts by time — the
// sk carries no time to sort by) — every caller (getMyRecord's index fold and wire response)
// sorts by the `finalizedAtMs` each line carries itself, at read time, over what is always a
// small, whole-career result set. This is deliberate, not a gap: the alternative (embedding
// order in the key) is exactly the bug this rewrite removes.
export interface ProjectionStore {
  // `createdAtMs` (accounts-only identity spec §5): the round-created event's own wall time, carried
  // on the line so getMyRounds can render the "course + date" designation without re-reading each
  // round's log. OPTIONAL: lines written before the field existed carry no created-at (tolerated on
  // read as absent — a rebuild backfills it, never a migration); projectArchive always provides it.
  //
  // `playedAtMs` (spec 2026-08-01 §4a): WHEN THE GOLF HAPPENED — domain's playedAtMsOf, the ONE
  // rule, projected onto every line so sortLines (projections/projectArchive.ts) can order a
  // golfer's history by it. REQUIRED, unlike createdAtMs: projectArchive is the only writer and it
  // always has a real value (playedAtMsOf throws on a genuinely corrupt log, never produces
  // undefined) — there is no legacy-line case to tolerate the way there is for createdAtMs.
  putLine(golferId: GolferId, line: GolferRoundLine & { readonly finalizedAtMs: number; readonly playedAtMs: number; readonly createdAtMs?: number }): Promise<void>;
  listLines(golferId: GolferId): Promise<readonly (GolferRoundLine & { readonly finalizedAtMs: number; readonly playedAtMs: number; readonly createdAtMs?: number })[]>;

  // Presence (spec §5). Implemented here — ahead of any real writer — so the store's shape
  // rewrites exactly once rather than growing a second time when realignment Task 13 (the
  // StartRound/JoinRound writers + "Your rounds" home read, AND the finalize-time deleteLive
  // call via projectArchive's per-participant loop) lands. `expiresAtSec` is epoch
  // SECONDS — DynamoDB TTL's own unit, unlike every other timestamp in this codebase
  // (milliseconds) — and the adapter writes it into the item's `ttl` attribute, the one the
  // projections table's TTL spec already names (apps/infra-cdk/lib/swngStack.ts, realignment
  // Task 1).
  putLive(golferId: GolferId, entry: { readonly roundId: RoundId; readonly courseName: string; readonly joinedAtMs: number; readonly expiresAtSec: number }): Promise<void>;
  deleteLive(golferId: GolferId, roundId: RoundId): Promise<void>;
  listLive(golferId: GolferId): Promise<readonly { roundId: RoundId; courseName: string; joinedAtMs: number }[]>;

  // The old crew ledger section is GONE (architecture-realignment Task 9, spec §4/§9): crew
  // standings are computed on read over the snapshots table (crews/getSeasonStandings), stored
  // nowhere. This is now a golfer-record + presence store only.
}
