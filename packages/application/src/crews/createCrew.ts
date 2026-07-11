import { addMember, crewId as toCrewId, validateCrewName } from "@swng/domain";
import type { Crew } from "@swng/domain";
import type { CreateCrewRequest, CreateCrewResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import { toCrewView } from "./crewView.js";
import { requireAccountGolfer } from "./membership.js";

// M9 hardening: the old single-shot `ids.newJoinCode()` made a collision permanent (the FIRST
// code drawn was used no matter what, even if another crew already held it) — bounded like
// retryOnConflict.ts's own MAX_ATTEMPTS (same "a human-paced, rare-collision resource doesn't
// need a real backoff timer" reasoning, retryOnConflict.ts's own doc comment). A fresh 6-char
// draw from a 32-symbol alphabet colliding with an existing crew 5 times running is
// astronomically unlikely at v1's scale — exhaustion here is a genuine-bug signal, not a
// capacity plan.
const MAX_JOIN_CODE_ATTEMPTS = 5;

const mintUniqueJoinCode = async (crewStore: CrewStore, ids: IdGenerator): Promise<string> => {
  for (let attempt = 0; attempt < MAX_JOIN_CODE_ATTEMPTS; attempt += 1) {
    const code = ids.newJoinCode();
    if ((await crewStore.findByJoinCode(code)) === undefined) return code;
  }
  throw new ApplicationError("join-code-exhausted", `no unique crew join code found after ${MAX_JOIN_CODE_ATTEMPTS} attempts`);
};

export const createCrew =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; ids: IdGenerator }) =>
  async (claims: AccountClaims, command: CreateCrewRequest): Promise<CreateCrewResponse> => {
    // golfer-required propagates if the caller has no account golfer yet (wire honesty, not
    // a flow — the web PUTs /me first).
    const golfer = await requireAccountGolfer(deps, claims);

    // M9 hardening (papercut 9): domain is the honest layer — the wire's own `.min(1)`
    // (contracts/crews.ts) never trims and has no upper bound; this is the real invariant,
    // checked before anything is minted or written (same "reject before touching state"
    // discipline as startRound.ts's own tee-set checks).
    validateCrewName(command.name);

    const id = toCrewId(deps.ids.newId());
    // Mints with the SAME machinery a round's own join code uses (IdGenerator.newJoinCode) —
    // the M8 plan's explicit mandate to reuse round's join-code minting — skipping any code an
    // existing crew already holds (M9 hardening, above).
    const joinCode = await mintUniqueJoinCode(deps.crewStore, deps.ids);
    const crew: Crew = addMember({ id, name: command.name, members: [] }, { golferId: golfer.id, name: golfer.name, role: "organizer" });

    // A fresh, server-minted crewId never collides with an existing item — same "nothing to
    // retry against" reasoning as createCourse's own unconditional put.
    await deps.crewStore.put(crew, joinCode, undefined);

    return { crew: await toCrewView({ golferStore: deps.golferStore }, crew, joinCode) };
  };
