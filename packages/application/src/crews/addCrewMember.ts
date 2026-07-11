import { addMember, golferId as toGolferId } from "@swng/domain";
import type { CrewId } from "@swng/domain";
import type { AddCrewMemberRequest, AddCrewMemberResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import { retryOnConflict } from "../retryOnConflict.js";
import { toCrewView } from "./crewView.js";
import { requireCrewMember } from "./membership.js";

// Mints a STABLE ghost golfer for a person without an account (M8 plan) — a real GolferStore
// row, unclaimed, so it's claimable later AND so this same id recurs across every round this
// crew plays (a crew's "play the usual" one-tap seating always resolves this member to the
// SAME golferId, not a fresh one per round). Account holders never enter a crew this way —
// they join by code (joinCrewByCode.ts) as their own golfer.
export const addCrewMember =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; ids: IdGenerator }) =>
  async (claims: AccountClaims, id: CrewId, command: AddCrewMemberRequest): Promise<AddCrewMemberResponse> => {
    // Only a fellow crew member may add someone to the roster.
    await requireCrewMember(deps, claims, id);

    // Papercut 10 (M9 hardening) — ordering decision, deliberate, not an oversight: the golfer
    // row is written HERE, BEFORE the crew write below, even though that means a crew write
    // that ultimately fails (crew-conflict exhausted, a genuine store error) leaves this ghost
    // row behind as an orphan. The reverse order was considered and rejected: retryOnConflict's
    // own contract requires `mutate` to be a PURE function of the current crew (its own doc
    // comment) re-run fresh on every retry attempt, so the member's golferId has to be minted
    // BEFORE the crew mutation is built either way (addMember needs a concrete id to embed) —
    // the only real choice is which side effect goes first. An orphan GOLFER row is inert and
    // harmless: nothing ever looks it up (no crew, no round references it), toCrewView's own
    // per-member golferStore.get gracefully treats a MISSING row as claimed:false when the
    // roles are reversed. An orphan CREW MEMBER (the reverse order) would be actively broken —
    // every downstream read of that member (toCrewView, requireCrewMember's own roster check,
    // ledger/records golferId lookups, a future "play the usual" one-tap seating) would resolve
    // against a golferId with no golfer row behind it at all. Golfer-row-first is strictly the
    // safer failure mode, so it stays.
    const ghostId = toGolferId(deps.ids.newId());
    // A fresh, server-minted golferId never collides with an existing item — unconditional
    // create, same reasoning as getOrCreateGolfer's own fresh-id put.
    await deps.golferStore.put({ id: ghostId, name: command.name, handicap: {} }, undefined);

    // joinCode never changes after minting (crewStore.ts's own doc comment) but crewStore.put
    // still requires it on every write — captured here from whichever read wins the retry race.
    let joinCode: string | undefined;
    const crew = await retryOnConflict(
      {
        get: async () => {
          const found = await deps.crewStore.get(id);
          if (!found) return undefined;
          joinCode = found.joinCode;
          return { value: found.crew, revision: found.revision };
        },
        put: (value, revision) => deps.crewStore.put(value, joinCode!, revision),
      },
      (current) => addMember(current, { golferId: ghostId, name: command.name, role: "member" }),
      { notFound: "unknown-crew", conflict: "crew-conflict" },
    );

    return { crew: await toCrewView({ golferStore: deps.golferStore }, crew, joinCode!) };
  };
