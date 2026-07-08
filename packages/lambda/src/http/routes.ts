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
import { addGameRequestSchema, joinRoundRequestSchema, recordScoreRequestSchema, startRoundRequestSchema } from "@swng/contracts";

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
    handler: async (ctx) => useCases.readEvents(roundId(ctx.pathParams.roundId!), Number(ctx.query.since ?? "0")),
  },
];
