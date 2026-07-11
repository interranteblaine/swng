import type { CrewId } from "@swng/domain";
import type { SaveStandingGameRequest, SaveStandingGameResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import { toCrewView } from "./crewView.js";
import { requireCrewMember } from "./membership.js";
import { retryOnConflict } from "./retryOnConflict.js";

// The crew's "play the usual" preset (product.md §6) — `standingGame` is set wholesale (no
// partial patch semantics, unlike updateMyGolfer's PATCH-like fields): a save always
// replaces whatever preset was there.
export const saveStandingGame =
  (deps: { crewStore: CrewStore; golferStore: GolferStore }) =>
  async (claims: AccountClaims, id: CrewId, command: SaveStandingGameRequest): Promise<SaveStandingGameResponse> => {
    await requireCrewMember(deps, claims, id);

    // command.standingGame's wire shape (games: GameConfigInput[]) is structurally the SAME
    // as domain's StandingGame (games: GameConfigDraft[] — both are the id-less per-kind
    // field sets, contracts/crews.ts's own doc comment) — no cast needed.
    const { crew, joinCode } = await retryOnConflict(deps.crewStore, id, (current) => ({ ...current, standingGame: command.standingGame }));

    return { crew: await toCrewView({ golferStore: deps.golferStore }, crew, joinCode) };
  };
