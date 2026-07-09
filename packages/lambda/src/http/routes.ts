import type { z } from "zod";
import { roundId } from "@swng/domain";
import type { RoundId } from "@swng/domain";
import type { ParticipantClaims } from "@swng/application";
import type {
  AddGameRequest,
  AddGameResponse,
  EventsResponse,
  FinalizeRoundResponse,
  JoinRoundRequest,
  JoinRoundResponse,
  RecordScoreRequest,
  RecordScoreResponse,
  StartRoundRequest,
  StartRoundResponse,
} from "@swng/contracts";
import { ContractError, addGameRequestSchema, joinRoundRequestSchema, recordScoreRequestSchema, startRoundRequestSchema } from "@swng/contracts";

// The deps-applied use-case functions from Task 2 (application/src/rounds/*.ts), one per
// route — the dispatcher is generic over this shape so it never imports application's use
// cases directly; compositionRoot.ts is the only place that builds one.
export interface UseCases {
  startRound: (command: StartRoundRequest) => Promise<StartRoundResponse>;
  joinRound: (command: JoinRoundRequest) => Promise<JoinRoundResponse>;
  addGame: (claims: ParticipantClaims, command: AddGameRequest) => Promise<AddGameResponse>;
  recordScore: (claims: ParticipantClaims, command: RecordScoreRequest) => Promise<RecordScoreResponse>;
  finalizeRound: (claims: ParticipantClaims) => Promise<FinalizeRoundResponse>;
  readEvents: (id: RoundId, sinceSeq: number) => Promise<EventsResponse>;
}

// What a route handler sees once the dispatcher has matched the path, verified auth, and
// parsed the body. `query` is additive to the brief's sketch — GET /rounds/{id}/events is
// the one route whose command shape isn't a JSON body, so its `since` cursor rides here
// instead (the dispatcher always populates it, `{}` when the request carried no query string).
export interface RouteContext {
  readonly claims?: ParticipantClaims;
  readonly pathParams: Record<string, string>;
  readonly query: Record<string, string>;
}

export interface Route {
  readonly method: "GET" | "POST";
  readonly path: string; // template with `{name}` segments, e.g. "/rounds/{roundId}/games"
  readonly schema?: z.ZodType;
  readonly auth: "none" | "participant";
  // 201 for routes that mint a new resource (round/participant/game); 200 for actions
  // that read or that may be an idempotent no-op (score, finalize, events).
  readonly successStatus: 200 | 201;
  readonly handler: (ctx: RouteContext, body: unknown) => Promise<unknown>;
}

// `since` defaults to "read from the start" and otherwise must be an integer seq — a
// non-integer (e.g. "abc", or Number's own parse of it: NaN) must be rejected here, as a
// ContractError, rather than reach adapters-dynamodb's evtSk(NaN + 1). Non-integer since
// feeds evtSk(NaN) = "EVT#0000000NaN"; under lexicographic BETWEEN, this drops seq ≤ 999
// but still returns seq ≥ 1000, silently amputating the head of the log a client folds
// over — strictly worse than an empty page. Reject with 400 instead.
const parseSinceSeq = (raw: string | undefined): number => {
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ContractError("invalid-request", [`since: must be an integer, got "${raw}"`]);
  }
  return parsed;
};

export const buildRoutes = (useCases: UseCases): readonly Route[] => [
  {
    method: "POST",
    path: "/rounds",
    schema: startRoundRequestSchema,
    auth: "none",
    successStatus: 201,
    handler: async (_ctx, body) => useCases.startRound(body as StartRoundRequest),
  },
  {
    method: "POST",
    path: "/rounds/join",
    schema: joinRoundRequestSchema,
    auth: "none",
    successStatus: 201,
    handler: async (_ctx, body) => useCases.joinRound(body as JoinRoundRequest),
  },
  {
    method: "POST",
    path: "/rounds/{roundId}/games",
    schema: addGameRequestSchema,
    auth: "participant",
    successStatus: 201,
    // The dispatcher only calls a "participant" route's handler once auth has produced
    // claims (http/dispatch.ts) — the assertion documents that invariant rather than
    // re-deriving it with a runtime check every route would otherwise repeat.
    handler: async (ctx, body) => useCases.addGame(ctx.claims!, body as AddGameRequest),
  },
  {
    method: "POST",
    path: "/rounds/{roundId}/scores",
    schema: recordScoreRequestSchema,
    auth: "participant",
    successStatus: 200,
    handler: async (ctx, body) => useCases.recordScore(ctx.claims!, body as RecordScoreRequest),
  },
  {
    method: "POST",
    path: "/rounds/{roundId}/finalize",
    auth: "participant",
    successStatus: 200,
    handler: async (ctx) => useCases.finalizeRound(ctx.claims!),
  },
  {
    method: "GET",
    path: "/rounds/{roundId}/events",
    auth: "participant",
    successStatus: 200,
    // Every "participant" route's path template declares {roundId} (this table, by
    // construction), so the dispatcher's path match always populates it.
    handler: async (ctx) => useCases.readEvents(roundId(ctx.pathParams.roundId!), parseSinceSeq(ctx.query.since)),
  },
];
