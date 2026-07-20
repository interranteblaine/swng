import type { GolferId } from "@swng/domain";
import type { GetGolferResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import { recordOf } from "./recordOf.js";

// GET /golfers/{golferId} (navigation spec §6a): the golfer page's read. Any signed-in golfer
// may view any golfer — the dispatcher's "golfer" auth tier already requires a signed-in
// caller (routes.ts), so unlike getMyRecord.ts this use case is NOT self-scoped and takes no
// claims at all; the target golferId rides the request instead (routes.ts's own path-param
// extraction). Runs the SAME lines-to-{metrics, history} fold getMyRecord.ts runs (recordOf.ts)
// — never a second implementation. A placeholder-named golfer serves its stored placeholder
// name as-is (the web, not this read, decides how to render it).
export const getGolfer =
  (deps: { golferStore: GolferStore; projectionStore: ProjectionStore }) =>
  async (request: { golferId: GolferId }): Promise<GetGolferResponse> => {
    const [found] = await deps.golferStore.getMany([request.golferId]);
    if (!found) throw new ApplicationError("golfer-not-found");

    const lines = await deps.projectionStore.listLines(found.golfer.id);
    const { metrics, history } = recordOf(lines);

    return {
      name: found.golfer.name,
      indexSource: found.golfer.handicap.indexSource,
      metrics,
      history,
    };
  };
