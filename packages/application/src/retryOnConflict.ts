import { ApplicationError, type ApplicationErrorCode } from "./errors.js";

// Bounded optimistic-concurrency retry for a "re-read, let the caller re-derive the next
// value, re-put under the fresh revision" mutation — the ONE shared implementation
// (conventions §0: a second verbatim instance, courses' and crews' own retryOnConflict.ts
// files, is exactly the trigger for building the general version) behind every
// revision-conditional CRUD store's use cases (courseStore.ts, crewStore.ts, ...). Every
// domain mutation these call sites replay is a pure function of the current entity, so
// re-running `mutate` against a fresher read IS "try again".
//
// Parameterized over get/mutate/put/conflict-code rather than over a concrete store type,
// because the stores themselves don't share a shape (CourseStore/CrewStore/GolferStore each
// have their own put/get signature) — each call site adapts its own store's get/put into this
// `{ value, revision }` shape rather than this module knowing about any store-specific extra.
//
// This has a precedent in adapters-dynamodb's journal append retry, but deliberately skips
// that retry's full-jitter backoff timer: the journal's loop exists to de-lockstep a burst of
// CONCURRENT machine writers hammering one round's head slot at outing scale, where
// courses/crews see rare, human-paced edits to the same aggregate — a tight bounded loop with
// no artificial delay is enough here, and a real backoff can be added later if beta telemetry
// says otherwise.
const MAX_ATTEMPTS = 5;

export const retryOnConflict = async <T>(
  store: {
    get: () => Promise<{ value: T; revision: number } | undefined>;
    put: (value: T, expectedRevision: number | undefined) => Promise<void>;
  },
  mutate: (value: T) => T,
  codes: { notFound: ApplicationErrorCode; conflict: ApplicationErrorCode },
): Promise<T> => {
  let lastConflict: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const found = await store.get();
    if (!found) throw new ApplicationError(codes.notFound);

    // Outside the try/catch on purpose: a DomainError from `mutate` itself (e.g. a duplicate
    // member, a stale expected version) is never a store conflict and must never be retried.
    const next = mutate(found.value);
    try {
      await store.put(next, found.revision);
      return next;
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.code !== codes.conflict) throw error;
      lastConflict = error;
    }
  }
  throw lastConflict;
};
