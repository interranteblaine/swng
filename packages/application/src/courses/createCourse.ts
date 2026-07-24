import { buildCardRecord, cardId as toCardId, courseId as toCourseId, teeId as toTeeId } from "@swng/domain";
import type { CreateCourseRequest, CreateCourseResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CardStore } from "../ports/cardStore.js";
import type { Clock } from "../ports/clock.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { Logger } from "../ports/logger.js";
import type { Metrics } from "../ports/metrics.js";
import { ensureGolfer } from "../golfers/ensureGolfer.js";
import { toCourseView } from "./courseView.js";

export const createCourse =
  (deps: { cardStore: CardStore; golferStore: GolferStore; idGenerator: IdGenerator; clock: Clock; logger: Logger; metrics?: Metrics }) =>
  async (claims: AccountClaims, command: CreateCourseRequest): Promise<CreateCourseResponse> => {
    // enteredBy derives from the account, never the wire (spec invariant 7) — the same
    // get-or-create startRound uses, frozen into the record at write time.
    const author = await ensureGolfer({ golferStore: deps.golferStore, idGenerator: deps.idGenerator, metrics: deps.metrics })(claims);
    const record = buildCardRecord({
      cardId: toCardId(deps.idGenerator.newId()),
      courseId: toCourseId(deps.idGenerator.newId()),
      courseName: command.name,
      teeSets: command.teeSets.map((tee) => ({ ...tee, teeId: toTeeId(deps.idGenerator.newId()) })),
      enteredBy: { golferId: author.id, name: author.name },
      enteredAtMs: deps.clock.now(),
    });
    await deps.cardStore.create(record);
    deps.logger.info("course-created", { courseId: record.courseId, cardId: record.cardId, name: command.name });
    return { course: toCourseView(record) };
  };
