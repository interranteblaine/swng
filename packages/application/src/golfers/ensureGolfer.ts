import type { Golfer } from "@swng/domain";
import { golferId, placeholderName } from "@swng/domain";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";

// Get-or-create on first touch (accounts-only identity spec §2): the first authenticated request
// that needs the caller's golfer mints it. Returns the caller's Golfer, always — minting only when
// none exists yet. This is the ONE place "one account = one golfer, born together" lives:
// GET /me (getMyGolfer.ts), PUT /me (updateMyGolfer.ts), and StartRound/JoinRound's own as-self
// seat all route through here, so no surface has its own get-or-create logic.
//
// Cognito is a pure authenticator (spec §2, controller ruling): this reads ONLY `claims.sub`,
// never the email or any name claim. The mint's display name is the deterministic backstop
// placeholderName(sub) ("Golfer 4821") with namePlaceholder: true — boring by design, and f(sub)
// so the concurrent-first-request race below can't even generate two different names. The web's
// funnel PUTs a real name at the highest-motivation moment (updateMyGolfer clears the flag then).
//
// The mint routes through the existing M9 SUB#<sub> attribute_not_exists transaction (put a fresh,
// sub-less row, then bindSub): the concurrent-first-request race's LOSER's bindSub throws
// golfer-already-claimed, caught here and turned into "re-read by sub, return the WINNER's golfer"
// — both requests converge on the SAME identity. (The loser's freshly-put row is left orphaned and
// unbound, unreachable by sub — an accepted outcome: nothing keys on a row no sub points at.)
export const ensureGolfer =
  (deps: { golferStore: GolferStore; idGenerator: IdGenerator }) =>
  async (claims: AccountClaims): Promise<Golfer> => {
    const existing = await deps.golferStore.getBySub(claims.sub);
    if (existing) return existing.golfer;

    const golfer: Golfer = { id: golferId(deps.idGenerator.newId()), name: placeholderName(claims.sub), handicap: {}, namePlaceholder: true };
    await deps.golferStore.put(golfer, undefined);

    try {
      await deps.golferStore.bindSub(golfer.id, claims.sub);
    } catch (error) {
      if (error instanceof ApplicationError && error.code === "golfer-already-claimed") {
        const winner = await deps.golferStore.getBySub(claims.sub);
        if (winner) return winner.golfer;
      }
      throw error;
    }

    const bound = await deps.golferStore.get(golfer.id);
    // bindSub just succeeded against the row we put above, so the item is guaranteed to exist
    // now (the SUB# bind transaction wrote it) — the non-null assertion is safe.
    return bound!.golfer;
  };
