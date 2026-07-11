import { referencedGolferIds } from "@swng/domain";
import type { CrewId } from "@swng/domain";
import type { SaveStandingGameRequest, SaveStandingGameResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import { retryOnConflict } from "../retryOnConflict.js";
import { toCrewView } from "./crewView.js";
import { requireCrewMember } from "./membership.js";

// The crew's "play the usual" preset (product.md §6) — `standingGame` is set wholesale (no
// partial patch semantics, unlike updateMyGolfer's PATCH-like fields): a save always
// replaces whatever preset was there.
export const saveStandingGame =
  (deps: { crewStore: CrewStore; golferStore: GolferStore }) =>
  async (claims: AccountClaims, id: CrewId, command: SaveStandingGameRequest): Promise<SaveStandingGameResponse> => {
    const membership = await requireCrewMember(deps, claims, id);

    // M9 hardening (papercut 8): a preset naming a golfer who isn't (or is no longer) on the
    // roster would silently seed a "play the usual" round with a stray, unresolvable player —
    // rejected here, against the SAME crew this membership check just read, before anything is
    // written (same "reject before touching state" discipline as startRound.ts's own tee-set
    // checks). referencedGolferIds is crew.ts's own per-game extraction (exported, papercut 8's
    // own doc comment there) — never a second, hand-rolled copy of that switch.
    const rosterIds = new Set(membership.crew.members.map((member) => member.golferId));
    const referenced = command.standingGame.games.flatMap((game) => referencedGolferIds(game));
    if (referenced.some((golferId) => !rosterIds.has(golferId))) {
      throw new ApplicationError("unknown-preset-player");
    }

    // joinCode never changes after minting (crewStore.ts's own doc comment) but crewStore.put
    // still requires it on every write — captured here from whichever read wins the retry race.
    let joinCode: string | undefined;
    // command.standingGame's wire shape (games: GameConfigInput[]) is structurally the SAME
    // as domain's StandingGame (games: GameConfigDraft[] — both are the id-less per-kind
    // field sets, contracts/crews.ts's own doc comment) — no cast needed.
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
      (current) => ({ ...current, standingGame: command.standingGame }),
      { notFound: "unknown-crew", conflict: "crew-conflict" },
    );

    return { crew: await toCrewView({ golferStore: deps.golferStore }, crew, joinCode!) };
  };
