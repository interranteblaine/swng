import type { Crew, CrewId } from "@swng/domain";
import { ApplicationError } from "../errors.js";
import type { CrewStore } from "../ports/crewStore.js";

// Bounded optimistic-concurrency retry for a single-crew mutation — mirrors courses'
// retryOnConflict.ts (same shape, same bound, same "re-read, let the caller re-derive the
// next value, re-put under the fresh revision" idea) but over CrewStore instead of
// CourseStore, since put/get here also carry the store-level joinCode (crewStore.ts's own
// doc comment) that courses' version has no equivalent of. A second near-identical instance
// of the pattern rather than a shared generic (conventions §0's counterweight, §3: one real
// abstraction over "a store with get/put(value, expectedRevision)" isn't obviously cheaper
// than this, and reaching into courses' own call sites to generalize is out of this task's
// scope) — a candidate for extraction if a third instance shows up.
const MAX_ATTEMPTS = 5;

export const retryOnConflict = async (crewStore: CrewStore, id: CrewId, mutate: (crew: Crew) => Crew): Promise<{ crew: Crew; joinCode: string }> => {
  let lastConflict: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const found = await crewStore.get(id);
    if (!found) throw new ApplicationError("unknown-crew");

    const next = mutate(found.crew);
    try {
      await crewStore.put(next, found.joinCode, found.revision);
      return { crew: next, joinCode: found.joinCode };
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.code !== "crew-conflict") throw error;
      lastConflict = error;
    }
  }
  throw lastConflict;
};
