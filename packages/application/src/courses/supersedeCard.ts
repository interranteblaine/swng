import { buildCardRecord, cardId as toCardId, teeId as toTeeId, validateTeeContinuity } from "@swng/domain";
import type { CourseId, TeeId } from "@swng/domain";
import type { SupersedeCardRequest, SupersedeCardResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CardStore } from "../ports/cardStore.js";
import type { Clock } from "../ports/clock.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { Logger } from "../ports/logger.js";
import { ApplicationError } from "../errors.js";
import { ensureGolfer } from "../golfers/ensureGolfer.js";
import { toCourseView } from "./courseView.js";

// THE maintenance operation (spec §4): add a tee, fix numbers, rename course or tee — all one
// whole-card supersession. Two card-superseded gates: an early friendly check on read (the
// common case reports before any work), and the store's transact condition (the true arbiter
// under a race — spec §6's one rule).
export const supersedeCard =
  (deps: { cardStore: CardStore; golferStore: GolferStore; idGenerator: IdGenerator; clock: Clock; logger: Logger }) =>
  async (claims: AccountClaims, id: CourseId, command: SupersedeCardRequest): Promise<SupersedeCardResponse> => {
    const current = await deps.cardStore.getCurrent(id);
    if (!current) throw new ApplicationError("course-not-found");
    if (current.cardId !== command.supersedes) {
      throw new ApplicationError("card-superseded", `course ${id}: current card is ${current.cardId}, not ${command.supersedes}`);
    }

    const inputTees = command.teeSets.map((tee) => ({ ...tee, teeId: tee.teeId as TeeId | undefined }));
    validateTeeContinuity(current.card, inputTees); // unknown-tee-id / duplicate-tee-id (DomainError) propagate

    const author = await ensureGolfer({ golferStore: deps.golferStore, idGenerator: deps.idGenerator })(claims);
    const record = buildCardRecord({
      cardId: toCardId(deps.idGenerator.newId()),
      courseId: id,
      courseName: command.name,
      teeSets: inputTees.map((tee) => (tee.teeId !== undefined ? tee : { ...tee, teeId: toTeeId(deps.idGenerator.newId()) })),
      enteredBy: { golferId: author.id, name: author.name },
      enteredAtMs: deps.clock.now(),
      supersedes: current.cardId,
    });
    await deps.cardStore.supersede(record);
    deps.logger.info("card-superseded", { courseId: id, cardId: record.cardId, replaced: current.cardId });
    return { course: toCourseView(record) };
  };
