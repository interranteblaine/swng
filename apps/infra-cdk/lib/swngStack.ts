import { join } from "node:path";
import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, Dashboard, GraphWidget, LogQueryWidget, MathExpression, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { AttributeType, BillingMode, ProjectionType, StreamViewType, Table } from "aws-cdk-lib/aws-dynamodb";
import { CfnRoute, CfnStage, CorsHttpMethod, DomainName, HttpApi, HttpMethod, WebSocketApi, WebSocketStage } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration, WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Certificate, CertificateValidation } from "aws-cdk-lib/aws-certificatemanager";
import { CfnManagedLoginBranding, CfnUserPoolClient, FeaturePlan, ManagedLoginVersion, OAuthScope, ResourceServerScope, UserPool, UserPoolClient, UserPoolDomain } from "aws-cdk-lib/aws-cognito";
import { Distribution, HeadersFrameOption, HeadersReferrerPolicy, ResponseHeadersPolicy, ViewerProtocolPolicy } from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource, SqsDlq } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { FilterPattern, MetricFilter } from "aws-cdk-lib/aws-logs";
import { ARecord, AaaaRecord, HostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
import { ApiGatewayv2DomainProperties, CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { CfnWebACL, CfnWebACLAssociation } from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";
import { managedLoginAssets, managedLoginSettings } from "./managedLoginBranding.js";

// The live POC stacks (deployed pre-rebuild, still holding production-shaped data) are
// named InfraCdkStack-beta / InfraCdkStack-prod — see CLAUDE.md. Constructing a SwngStack
// under either name (or any InfraCdkStack* name) would let a routine `cdk deploy` silently
// replace or delete those resources instead of standing up the new swng-<stage> stack. This
// throws BEFORE `super()` runs, so it fails at construct time, not at deploy time.
const FORBIDDEN_ID = /^InfraCdkStack/;

export interface SwngStackProps extends StackProps {
  // Stage suffix for every resource name in this stack (table names, secret name, the
  // WebSocket stage). Defaults to "beta" — swng has no "prod" stack yet (M3 scope is beta
  // only; CLAUDE.md).
  readonly stage?: string;
  // Task D-T1 (custom domain): the first real per-stage D5-style config, supplied by
  // bin/infra-cdk.ts's own STAGE_WEB table — never a `stage === "prod"`-shaped branch inside
  // this stack. hostedZoneId/zoneName identify an ALREADY-PROVISIONED Route 53 zone this stack
  // imports (not owns); domainName is the alias this stack mints a cert for and claims via
  // Route 53 alias records. OPTIONAL and absent today for every stage but beta: when absent,
  // this stack synthesizes byte-identical to before this prop existed — pinned by the existing
  // test suite's shared prop-less template continuing to pass unmodified.
  readonly web?: { readonly domainName: string; readonly hostedZoneId: string; readonly zoneName: string };
  /** Direct USER_PASSWORD_AUTH on the app client. Beta: true (e2e mints tokens via InitiateAuth).
   *  Prod: false — no direct password auth exposed to brute-forcing. Default true (beta). */
  readonly userPasswordAuth?: boolean;
  /** Non-domain origins added to BOTH the Cognito callback/logout lists and CORS (the dev/preview
   *  localhost origins). Beta: the two localhost ports. Prod: []. Default = beta's localhost pair. */
  readonly extraWebOrigins?: string[];
  /** CORS-only extra origins (beta's own cloudfront.net literal, hardcoded because CORS is computed
   *  before the distribution exists — the Arc A cycle note). Prod: []. Default = beta's cloudfront.net. */
  readonly extraCorsOrigins?: string[];
  /** Explicit Cognito password policy. Prod sets a strong one; beta omits it (Cognito default) so
   *  beta's admin-created e2e users with fixed passwords aren't rejected. Default undefined. */
  readonly passwordPolicy?: {
    readonly minLength: number;
    readonly requireLowercase: boolean;
    readonly requireUppercase: boolean;
    readonly requireDigits: boolean;
    readonly requireSymbols: boolean;
  };
  /** Pool-level deletion protection (prod: real accounts). Default false (beta). */
  readonly poolDeletionProtection?: boolean;
  /** Pin Cognito's PreventUserExistenceErrors to ENABLED (stops user-enumeration on sign-in/reset).
   *  Prod: true. Beta omits it (byte-identical — CDK renders no line when absent). Default undefined. */
  readonly preventUserExistenceErrors?: boolean;
  /** swng-speaks-mcp design §6: the MCP endpoint and its mediating authorization server. Same
   *  shape as `web` above and the same rule: OPTIONAL, and a stage without it synthesizes
   *  byte-identical to before this prop existed (spec §10.4 — beta only in this arc; prod keeps
   *  serving its current build untouched). hostedZoneId/zoneName identify the ALREADY-PROVISIONED
   *  Route 53 zone this stack imports; domainName is the host it mints a cert for and claims.
   *  The canonical MCP resource URI is DERIVED from domainName (`https://<host>/mcp`) rather than
   *  configured separately — spec §4.3's "one constant, three roles" only holds if there is
   *  exactly one place it comes from. */
  readonly mcp?: { readonly domainName: string; readonly hostedZoneId: string; readonly zoneName: string };
}

// The dispatcher (packages/lambda/src/http/dispatch.ts) does its own method+path matching
// against event.rawPath, so API Gateway just needs to forward each of these to the `http`
// function — but the (42, as of MCP-prep Task 7: +GET /rounds/{roundId}/view, the ONE route that
// serves a FOLDED round — 41 before that, as of spec 2026-08-02 §3b: +POST /rounds/{roundId}/holes, the holes a
// round set out to play, corrected — 40 before that, as of spec 2026-08-01 §3b/§4:
// +POST /rounds/{roundId}/played-at, a round's played date corrected — 39 before that, as of
// "the season is the record" spec
// 2026-07-22: +PUT .../seasons/{seasonId} and +PUT /crews/{crewId} replace the deleted POST
// close/reopen verbs, and GET /crews/{crewId}/records — the all-time surface, §4 — is deleted
// whole, netting 40 back down to 39; the navigation spec's GET /golfers/{golferId} had brought
// this to 37 before that; the course-cards wire switch trimmed it to 36 before that by dropping
// add-tee/verify for one whole-card PUT /courses/{courseId}) routes are declared here explicitly (matching
// packages/lambda/src/http/routes.ts) rather than via a single $default catch-all, so the API's
// shape is visible in the CloudFormation template and the AWS console, not hidden inside the
// Lambda. Exported (not module-private) so test/routesParity.test.ts can pin this table against
// buildRoutes' own {method, path} set — infra depends on lambda, the correct direction, so that
// guard lives here rather than in packages/lambda.
export const HTTP_ROUTES: ReadonlyArray<{ readonly method: HttpMethod; readonly path: string }> = [
  { method: HttpMethod.POST, path: "/rounds" },
  { method: HttpMethod.POST, path: "/rounds/join" },
  { method: HttpMethod.POST, path: "/rounds/{roundId}/games" },
  { method: HttpMethod.POST, path: "/rounds/{roundId}/scores" },
  { method: HttpMethod.POST, path: "/rounds/{roundId}/finalize" },
  // task-15: scrap a round — a terminal event that produces NO snapshot, so the round counts
  // nowhere. "participant"-gated, same tier as finalize above.
  { method: HttpMethod.POST, path: "/rounds/{roundId}/abandon" },
  // accounts-only identity spec §4: a participant walks off — "participant"-gated, self-only.
  { method: HttpMethod.POST, path: "/rounds/{roundId}/leave" },
  // spec 2026-07-30 §2: any participant sets any participant's strokes (score-for-anyone) —
  // "participant"-gated, same tier as leave/finalize above.
  { method: HttpMethod.POST, path: "/rounds/{roundId}/strokes" },
  // spec 2026-08-01 §3b/§4: any participant corrects the round's played date —
  // "participant"-gated, same tier as strokes/leave/finalize above. Deliberately NOT in
  // ANON_THROTTLED_ROUTES below — same story as strokes/leave (a round-scoped participant token
  // is required first, a higher bar than the anonymous-reachable routes there).
  { method: HttpMethod.POST, path: "/rounds/{roundId}/played-at" },
  // spec 2026-08-02 §3b: any participant corrects the holes the round set out to play —
  // "participant"-gated, same tier as played-at/strokes/leave/finalize above. Deliberately NOT
  // in ANON_THROTTLED_ROUTES below — same story as played-at/strokes/leave.
  { method: HttpMethod.POST, path: "/rounds/{roundId}/holes" },
  { method: HttpMethod.GET, path: "/rounds/{roundId}/events" },
  // M9 Task 3 (share): mints this round's immortal spectator link — participant-gated, same
  // tier as finalize/terminate above.
  { method: HttpMethod.POST, path: "/rounds/{roundId}/share" },
  // Projection-realignment Task 6: the settled snapshot's own event log — "golfer"-gated
  // (routes.ts's own doc comment on why this differs from GET /rounds/{roundId}/events'
  // round-scoped "round-read" tier just above).
  { method: HttpMethod.GET, path: "/rounds/{roundId}/archive" },
  // MCP-prep Task 7: the folded round — "golfer"-gated, same tier as the archive route just
  // above (routes.ts's own doc comment covers why: mintParticipantToken 409s a finalized
  // round, so a round-scoped tier can't cover both live and settled reads).
  { method: HttpMethod.GET, path: "/rounds/{roundId}/view" },
  // Architecture-realignment Task 14: the participant-token re-mint — "golfer"-gated, same
  // tier as the archive route just above. Scoring capability derives from participation, not
  // the device that joined.
  { method: HttpMethod.POST, path: "/rounds/{roundId}/token" },
  // Peek + the course CRUD/search surface. Course-cards spec §4: the M6 add-tee/verify routes
  // are GONE — one whole-card supersession (PUT /courses/{courseId}) replaces both, and writes
  // are "golfer"-gated (API Gateway forwards on method/path only, so the auth-tier move needs no
  // edit here; the path change does).
  { method: HttpMethod.GET, path: "/rounds/peek" },
  { method: HttpMethod.POST, path: "/courses" },
  { method: HttpMethod.PUT, path: "/courses/{courseId}" },
  { method: HttpMethod.GET, path: "/courses/{courseId}" },
  { method: HttpMethod.GET, path: "/courses" },
  // M7 Task 5: game/round termination + the golfer identity surface.
  { method: HttpMethod.POST, path: "/rounds/{roundId}/games/{gameId}/terminate" },
  { method: HttpMethod.GET, path: "/me" },
  { method: HttpMethod.PUT, path: "/me" },
  { method: HttpMethod.GET, path: "/me/record" },
  // Analytics spec 2026-07-21 §4: "your record here" — same golfer tier as GET /me/record,
  // filtered to one course.
  { method: HttpMethod.GET, path: "/me/courses/{courseId}/record" },
  // Projection-realignment Task 6: "list my rounds" — same golfer tier as GET /me/record.
  { method: HttpMethod.GET, path: "/me/rounds" },
  // Projection-realignment Task 13: "your rounds, right now" — presence, not finalized
  // history. Same golfer tier.
  { method: HttpMethod.GET, path: "/me/rounds/live" },
  // Navigation spec §6a: the golfer page's read — "golfer"-gated but NOT self-scoped (the
  // target golferId rides the path). Deliberately absent from ANON_THROTTLED_ROUTES below —
  // it always requires a signed-in caller, unlike the "none"-auth course reads.
  { method: HttpMethod.GET, path: "/golfers/{golferId}" },
  // M8 Task 4: crews. POST /rounds and POST /rounds/join above are unchanged PATHS — accounts-
  // only identity (spec §3) moved their auth tier to "golfer" (routes.ts), but API Gateway
  // forwards every method/path here identically regardless of auth tier, so this table needs no
  // edit for that part of the change.
  { method: HttpMethod.POST, path: "/crews" },
  // POST /crews/join's PATH is unchanged (crew membership, invited in — spec §2/§3 swapped its
  // BODY from a permanent {code} to a bearer {token}; API Gateway forwards on method/path only).
  { method: HttpMethod.POST, path: "/crews/join" },
  // Crew membership (invited in, accountable out — spec §2): the "none"-auth consent-screen
  // preview, mirrors GET /rounds/peek's own pre-join-preview story — joins the anonymous
  // throttle set (ANON_THROTTLED_ROUTES below).
  { method: HttpMethod.POST, path: "/crews/peek" },
  { method: HttpMethod.GET, path: "/me/crews" },
  { method: HttpMethod.GET, path: "/crews/{crewId}" },
  // Spec 2026-07-22 "the season is the record" §2: the crew name is editable — organizer-only,
  // "golfer"-gated same as every other crew route.
  { method: HttpMethod.PUT, path: "/crews/{crewId}" },
  // Crew membership (invited in, accountable out — spec §2): mints a fresh 7-day invite link —
  // ANY member, not organizer-only. POST /crews/{crewId}/members (add-by-id) is GONE — nobody
  // is conscripted onto a roster; they accept an invite (spec §3).
  { method: HttpMethod.POST, path: "/crews/{crewId}/invites" },
  // Architecture-realignment Task 9: crew seasons + standings-on-read + leave. (GET
  // /crews/{crewId}/records was GONE here — the old crew projection layer it read from was
  // deleted — analytics spec 2026-07-21 §5 briefly brought it back, computed on read, but spec
  // 2026-07-22 §4 deletes the whole all-time surface for good: a season can represent any span,
  // including effectively all of a crew's history, by stating wide dates, so a second surface
  // aggregating "everything" is redundant machinery. The counting apparatus — POST/DELETE
  // .../seasons/{seasonId}/rounds — is deleted whole too, crew-scoreboard spec §2b: standings
  // are a computed window over shared rounds now, never a stored ledger of counted rounds.)
  { method: HttpMethod.POST, path: "/crews/{crewId}/seasons" },
  { method: HttpMethod.GET, path: "/crews/{crewId}/seasons" },
  // Spec 2026-07-22 "the season is the record" §2: editing the end date IS the whole lifecycle
  // — this ONE PUT replaces the deleted close/reopen verbs — "golfer"-gated same as every other
  // season route, deliberately NOT in ANON_THROTTLED_ROUTES below (a signed-in crew organizer
  // is required to reach it).
  { method: HttpMethod.PUT, path: "/crews/{crewId}/seasons/{seasonId}" },
  { method: HttpMethod.GET, path: "/crews/{crewId}/seasons/{seasonId}/standings" },
  { method: HttpMethod.POST, path: "/crews/{crewId}/leave" },
  // Crew membership (invited in, accountable out — spec §1): the organizer's authority — remove
  // (organizer-only, target in the path) and transfer (organizer-only, target in the body).
  { method: HttpMethod.DELETE, path: "/crews/{crewId}/members/{golferId}" },
  { method: HttpMethod.POST, path: "/crews/{crewId}/transfer" },
];

// M9 Task 5 (ops): the highest-abuse-value routes get the tighter per-route ceiling below —
// eight as of the course-cards wire switch (the M6 add-tee/verify routes are gone; PUT
// /courses/{courseId} takes their place). Four are genuinely no-token-reachable (routes.ts's
// `auth: "none"`): GET /rounds/peek (no participant exists yet to hold a token before joining),
// POST /crews/peek (same story, one crew's invite link instead of a round's join code), and the
// two course READ routes (GET /courses, GET /courses/{courseId} — public data anyone may fetch
// to pick a tee). POST /rounds, POST /rounds/join, POST /courses, and PUT /courses/{courseId}
// are golfer-gated now but deliberately STAY in this set: round creation, self-join, and course
// create/maintenance are the abuse-sensitive write operations, and a Cognito account is a low,
// free, self-service barrier, so the tighter ceiling still earns its keep on them. Re-tuning the
// throttle set is otherwise out of scope. Every OTHER route requires a participant token minted
// off a join code (or, for crews, a signed-in account) first, a higher bar. Cross-checked
// against HTTP_ROUTES itself in swngStack.test.ts (every entry here must also be a real route)
// so a typo'd path fails loudly instead of silently throttling nothing.
export const ANON_THROTTLED_ROUTES: ReadonlyArray<{ readonly method: HttpMethod; readonly path: string }> = [
  { method: HttpMethod.POST, path: "/rounds" },
  { method: HttpMethod.POST, path: "/rounds/join" },
  { method: HttpMethod.GET, path: "/rounds/peek" },
  { method: HttpMethod.POST, path: "/crews/peek" },
  { method: HttpMethod.POST, path: "/courses" },
  { method: HttpMethod.PUT, path: "/courses/{courseId}" },
  { method: HttpMethod.GET, path: "/courses/{courseId}" },
  { method: HttpMethod.GET, path: "/courses" },
];

// --- The MCP surface's own route table (swng-speaks-mcp design §6) ------------------------
//
// Declared beside HTTP_ROUTES for the same reason: the API's shape belongs in the template and
// the console, not hidden inside a Lambda. It matters more here than there. `entries/mcpAuth.ts`
// dispatches on the NORMALIZED pathname, so `POST /authorize/../token` reaches handleToken —
// harmless as things stand, and unreachable at the gateway once every route key is explicit. A
// single `ANY /{proxy+}` would hand every malformed and traversal-shaped path straight to that
// switch and remove the one structural guard against it.
//
// The METHOD on each row is the one that surface actually serves (the browser leg is GET, the
// credential-bearing legs are POST) — a request on any other verb is a gateway 404 rather than
// reaching the dispatcher at all.
//
// These paths are the SAME STRINGS packages/lambda/src/oauth/paths.ts serves and metadata.ts
// advertises, retyped here and coupled by a parity test (test/mcpCanonical.test.ts) rather than
// imported — the identical mechanism routesParity.test.ts already provides for HTTP_ROUTES, and
// the one this arc has now had to install three times for retyped literals. A comment is not a
// mechanism.
//
// WHY NOT IMPORT THEM (corrected in fix round 1, Minor 1 — the original claim here, that a synth
// CANNOT import a workspace package, was simply false: this file already imports @swng/brand
// through ./managedLoginBranding.js, and `pnpm deploy:beta` is a bare `cdk deploy` with no build
// step, so that import already resolves to a gitignored dist). The real reason is narrower and
// still holds: importing @swng/lambda's barrel would drag the whole composition root, every
// adapter and the AWS SDK into the synth process to read a few strings, and it would put a
// LOAD-BEARING value — the callback URL Cognito matches exactly — behind a possibly-stale dist. A
// stale brand colour is a cosmetic defect; a stale callback path strands a signed-in golfer on a
// 404. The parity test costs neither.

/** The canonical resource's own path. `https://<mcp host>/mcp` is simultaneously the MCP endpoint
 *  URL, the Cognito resource server identifier and the PRM `resource` (spec §4.3, measured F3),
 *  so this ONE constant is also the `POST` route below and the suffix RFC 9728 §3.1 appends to
 *  the protected-resource metadata path. */
export const MCP_ENDPOINT_PATH = "/mcp";
/** Typed once: it is both a route below AND the Cognito app client's registered callback URL, and
 *  Cognito matches that EXACTLY. `packages/lambda/src/oauth/paths.ts`'s CALLBACK_PATH is the
 *  authority; the parity test pins these together. */
export const MCP_CALLBACK_PATH = "/oauth/callback";
export const MCP_CONSENT_PATH = "/oauth/consent";

/** The `mcp` function's two routes — both on the canonical path.
 *
 *  POST is the endpoint itself. GET is here because 405 is a SPECIFIED SIGNAL at this one path,
 *  not a generic wrong-verb answer (fix round 1, Important 2): the SDK's `legacy: "stateless"` leg
 *  answers GET with `405 Method not allowed.` to say "no SSE stream here", and
 *  `@modelcontextprotocol/client` special-cases exactly that status — `_startOrAuthSse` returns
 *  cleanly on 405 and throws `SdkHttpError` (firing `onerror`) on anything else. Every 2025-era
 *  connection opens that GET right after `initialized`, and spec §2 says Claude speaks 2025-era
 *  MCP today. Routed POST-only, the gateway's own `{"message":"Not Found"}` would arrive instead
 *  and every single connection would carry a transport error. Still an explicit key, still no
 *  catch-all: this only lets the handler's own answer be the answer.
 *
 *  The three OAuth endpoints below stay method-pinned, because nothing in OAuth gives a
 *  wrong-verb 405 any protocol meaning — that trade is only wrong where the status is a signal. */
export const MCP_ROUTES: ReadonlyArray<{ readonly method: HttpMethod; readonly path: string }> = [
  { method: HttpMethod.POST, path: MCP_ENDPOINT_PATH },
  { method: HttpMethod.GET, path: MCP_ENDPOINT_PATH },
];

/** The eight surfaces `entries/mcpAuth.ts` routes (its own path switch, plus the resource-suffixed
 *  protected-resource document RFC 9728 §3.1 requires). */
export const MCP_AUTH_ROUTES: ReadonlyArray<{ readonly method: HttpMethod; readonly path: string }> = [
  // RFC 9728 §3.1 serves this document at BOTH the bare path (a client that never saw a 401
  // challenge asks for that one) and the path with the resource's own path appended (what the
  // SDK's getOAuthProtectedResourceMetadataUrl puts in every challenge). A 404 on the advertised
  // one is a hard connection failure, not a slow path.
  { method: HttpMethod.GET, path: "/.well-known/oauth-protected-resource" },
  { method: HttpMethod.GET, path: `/.well-known/oauth-protected-resource${MCP_ENDPOINT_PATH}` },
  // RFC 8414 §3.1 — served at the bare path ONLY: its issuer is the origin, and §3.3 has the
  // client refuse a document whose issuer disagrees with where it was fetched from.
  { method: HttpMethod.GET, path: "/.well-known/oauth-authorization-server" },
  // RFC 7591 DCR, the deprecated fallback for a client that never learned CIMD. POST only —
  // routeRegister answers anything else 405, and a GET would reach it with an empty body.
  { method: HttpMethod.POST, path: "/register" },
  // The browser legs: the golfer's own sign-in and Cognito's redirect back. Both read only the
  // query string.
  { method: HttpMethod.GET, path: "/authorize" },
  { method: HttpMethod.GET, path: MCP_CALLBACK_PATH },
  // The two that mint or redeem a credential — POST, always, and pinned in the handlers too.
  { method: HttpMethod.POST, path: MCP_CONSENT_PATH },
  { method: HttpMethod.POST, path: "/token" },
];

// packages/lambda/src/entries/*.ts — resolved relative to this file so bundling works
// whether CDK is invoked from apps/infra-cdk or the repo root.
const entryPath = (name: string): string => join(import.meta.dirname, "..", "..", "..", "packages", "lambda", "src", "entries", `${name}.ts`);

export class SwngStack extends Stack {
  constructor(scope: Construct, id: string, props: SwngStackProps = {}) {
    if (FORBIDDEN_ID.test(id)) {
      throw new Error(
        `SwngStack: id "${id}" collides with the live POC stack namespace (InfraCdkStack-*). ` +
          "Deploying under that name would touch — or delete — the POC's live resources. Use \"swng-<stage>\" instead.",
      );
    }
    super(scope, id, props);

    const stage = props.stage ?? "beta";

    // --- Tables (M3 plan / docs/architecture.md §3 persistence sketch) ---------------

    const roundsTable = new Table(this, "RoundsTable", {
      tableName: `swng-rounds-${stage}`,
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      // The event log is the source of truth for a round in flight — never delete this table
      // out from under a stack teardown.
      removalPolicy: RemovalPolicy.RETAIN,
      // STILL ENABLED, CONSUMED BY NOTHING (owner-directed record, 2026-07-15). M7 Task 4
      // added this stream to feed the ProjectorFunction (filtered to ARCHIVE items); the
      // snapshot realignment moved that event source to the snapshots table below, and the
      // ARCHIVE item this stream was kept alive for died with putArchive — its original
      // reason no longer exists. It stays enabled purely because disabling it is a deliberate
      // change to a RETAIN table that deserves its own reviewed task (candidate: the
      // prod-stack arc), not a drive-by.
      //
      // POISON-FLOOD WARNING before ever attaching a consumer here: the course-cards beta
      // scrap (scripts/scrapCourseAndRoundData.mjs, 2026-07-15) emitted ~130k REMOVE records
      // into this stream in one pass — harmless only because nothing reads it. The snapshots
      // stream's consumer was saturated for hours by exactly this shape the same day (1,080
      // REMOVEs treated as poison records; see compositionRoot.ts's projector handler, which
      // now skips REMOVEs). Any future consumer of THIS stream must handle REMOVEs and the
      // table's mixed item kinds (EVT#/META/OPID#) from its first deploy — and bulk-delete
      // scripts must name every stream consumer in their blast radius before running.
      stream: StreamViewType.NEW_IMAGE,
      // Prod-readiness hardening Task 7: the event log is the source of truth for a round in
      // flight (see the RETAIN comment above) — continuous backup and deletion protection are
      // both in-place-modifiable DynamoDB properties (no replacement of this live table).
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
    });
    roundsTable.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "joinCode", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // Snapshot realignment Task 1 (docs/superpowers/specs/2026-07-12-projection-realignment-
    // design.md §1/§2/§11): "the atom" — one immutable item per finalized round, pk-only (no
    // sk: a key is an identity, time is an attribute — the plan's own Global Constraints rule
    // out a sort key ever embedding a timestamp here). A later task makes the finalize
    // transaction (round-finalized append + this table's put, ONE TransactWriteItems) the
    // sole writer; nothing else ever puts here. RETAIN + PITR mirror the rounds table's own
    // durability posture above — a finalized round is exactly as irreplaceable as the event
    // log it was settled from. The stream feeds ProjectorFunction below with NO filter: every
    // item on this table already IS a finished round, unlike the rounds table's own stream
    // (which mixed in every EVT#/OPID#/META record too, hence that one's now-unused ARCHIVE
    // filter — deleted outright below, not narrowed, per spec §2 "no filter, no branching").
    const snapshotsTable = new Table(this, "SnapshotsTable", {
      tableName: `swng-snapshots-${stage}`,
      partitionKey: { name: "pk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      // Prod-readiness hardening Task 7: migrated off the deprecated boolean `pointInTimeRecovery`
      // to this non-deprecated form — a template no-op (both synth to the identical
      // `PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true }` CFN block;
      // confirmed via `cdk synth` diff). Deletion protection is new here, same in-place-only
      // rationale as the rounds table above — a finalized round's snapshot is irreplaceable.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      stream: StreamViewType.NEW_IMAGE,
    });

    // The core table now backs courses (course-cards spec §5: createDynamoCardStore) — a card
    // lineage under pk `COURSE#<id>`: one mutable CURRENT pointer (sk `CURRENT`) plus one
    // write-once item per card (sk `CARD#<cardId>`), no separate event log. gsi1 is the
    // course-name search index over the CURRENT pointers: a single partition across every course
    // (gsi1pk fixed to one constant — adapters-dynamodb/src/keys.ts's courseGsi1pk — a
    // deliberate v1 choice; thousands of courses sit trivially inside one partition's limits,
    // and re-sharding is real future work only if beta telemetry ever shows it running hot),
    // sorted by the normalized name (gsi1sk) so search is one begins_with Query. Projected to
    // `name` only — courseId parses back out of the always-projected base-table `pk`, so the
    // full course document and its revision counter never leave the base table over the GSI.
    const coreTable = new Table(this, "CoreTable", {
      tableName: `swng-core-${stage}`,
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      // Prod-readiness hardening Task 7: courses + golfer identity are as irreplaceable as the
      // round log itself — same in-place-only PITR/deletion-protection posture as roundsTable.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
    });
    coreTable.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: AttributeType.STRING },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: ["name"],
    });
    // M7 Task 3/4: the sub→golfer lookup GolferStore.getBySub queries (createDynamoGolferStore
    // already queries this locally; this is the real CDK construct). gsi2pk/gsi2sk are set on
    // a golfer item only once claimed (keys.ts's golferGsi2pk/golferGsi2sk doc comment) —
    // ProjectionType.ALL because golfer items are small, unlike gsi1's course documents, so
    // there's no reason to pay INCLUDE's bookkeeping cost here.
    coreTable.addGlobalSecondaryIndex({
      indexName: "gsi2",
      partitionKey: { name: "gsi2pk", type: AttributeType.STRING },
      sortKey: { name: "gsi2sk", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // Projections (docs/architecture.md §6) — one history line per finalized round a golfer
    // played plus a running index snapshot (adapters-dynamodb/src/keys.ts). Provisioned since
    // M6; M7 Task 4 is the first task to actually grant access to it (below) and wire the
    // stream that feeds it (ProjectorFunction).
    const projectionsTable = new Table(this, "ProjectionsTable", {
      tableName: `swng-projections-${stage}`,
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      // Snapshot realignment Task 1 / spec §5: presence rows (a golfer's currently-live rounds,
      // written in a later task) are self-expiring — TTL is provisioned now, forward of that
      // task, same idiom M7 Task 4 used granting httpFn TABLE_PROJECTIONS access before any
      // route read it. Golfer-record items (history lines, the index) never set `ttl`, so DynamoDB's
      // background sweep never touches them — TTL only deletes items that carry the attribute.
      timeToLiveAttribute: "ttl",
      // Prod-readiness hardening Task 7: deletion protection guards against an accidental
      // teardown, but PITR is deliberately withheld — this table is a paged
      // `rebuildProjections` backfill away from the snapshots table's own PITR-backed history,
      // so a second continuous-backup stream here would be redundant durability spend.
      deletionProtection: true,
    });

    const connectionsTable = new Table(this, "ConnectionsTable", {
      tableName: `swng-connections-${stage}`,
      partitionKey: { name: "pk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      // Pure WS fan-out state, rebuildable from nothing (clients just reconnect) — safe to
      // destroy on stack teardown, unlike the three tables above.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    connectionsTable.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "roundId", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // --- Identity (M7 Task 4; docs/architecture.md §3: "Cognito stays a dumb credential box
    // behind the IdentityProvider port") -------------------------------------------------

    const userPool = new UserPool(this, "UserPool", {
      userPoolName: `swng-${stage}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      // Self-sign-up with no phone/SMS setup in v1 — email is the only channel that can
      // actually prove account ownership here.
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      // Holds real users the moment beta has its first signed-in golfer — never destroy this
      // out from under a stack teardown (mirrors the rounds/core/projections tables above).
      removalPolicy: RemovalPolicy.RETAIN,
      // Managed login (below) requires the Essentials feature plan; set it explicitly
      // (deterministic rather than relying on the AWS default). No-interruption update; prod
      // needs it for managed login regardless.
      featurePlan: FeaturePlan.ESSENTIALS,
      // Prod-readiness Arc C Task 2: an explicit strong policy for prod; beta omits this entirely
      // (Cognito's own default) so beta's admin-created e2e users with fixed test passwords keep
      // working unchanged. Conditional spread, not an always-present property with defaulted
      // fields, so an absent passwordPolicy prop leaves beta's synth byte-identical.
      ...(props.passwordPolicy
        ? {
            passwordPolicy: {
              minLength: props.passwordPolicy.minLength,
              requireLowercase: props.passwordPolicy.requireLowercase,
              requireUppercase: props.passwordPolicy.requireUppercase,
              requireDigits: props.passwordPolicy.requireDigits,
              requireSymbols: props.passwordPolicy.requireSymbols,
            },
          }
        : {}),
      // Real accounts in prod must never be deletable via a routine stack update/teardown.
      // Conditional spread, not an always-present property with a defaulted `false`, so beta
      // (poolDeletionProtection unset) emits NO DeletionProtection line at all — keeping beta's
      // synth byte-identical. Prod (`true`) renders DeletionProtection: "ACTIVE".
      ...(props.poolDeletionProtection ? { deletionProtection: true } : {}),
    });

    // The web app's origins, for both OAuth callback and logout redirects (and, Task 6 below,
    // the HTTP API's own CORS allow-list) — a cdk context list (`-c
    // WEB_ORIGINS='["https://..."]'` or cdk.json) so a real deployed web app URL can be added
    // without a code change; defaults to the local dev server AND the Playwright field-test's
    // preview port. DO NOT "clean up" http://localhost:4173: `pnpm e2e:field` (a close-out
    // gate) serves the built web app via `vite preview` on exactly this port
    // (apps/web/playwright.config.ts) and calls the deployed beta API cross-origin — dropping
    // it here breaks that gate on CORS. `cdk synth` and this stack's own tests never depend on
    // WEB_ORIGINS context being set.
    const webOrigins = props.extraWebOrigins ?? (this.node.tryGetContext("WEB_ORIGINS") as string[] | undefined) ?? ["http://localhost:5173", "http://localhost:4173"];

    // Task D-T1's custom-domain config — resolved here (not down in the custom-domain section
    // below) because Task 6's CORS scoping (below, at the HTTP API) needs it too; it's a plain
    // `props.web` read with no construct dependency, so hoisting it costs nothing and keeps it
    // a single declaration referenced by both.
    const webDomain = props?.web;

    const userPoolClient = new UserPoolClient(this, "UserPoolClient", {
      userPool,
      userPoolClientName: `swng-web-${stage}`,
      // SPA: the client runs entirely in the browser, so it can never keep a secret.
      generateSecret: false,
      authFlows: {
        // The real web app only ever uses the authorization-code+PKCE flow below —
        // USER_PASSWORD_AUTH exists solely so `pnpm e2e:beta` can mint a real ID token via
        // InitiateAuth without driving a browser through the hosted UI. M9 hardening item:
        // narrow or remove this once the e2e gate has another way to authenticate.
        userPassword: props.userPasswordAuth ?? true,
      },
      oAuth: {
        // PKCE is implicit for a public client (no secret) using the authorization-code grant
        // — there's no separate CDK flag for it.
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        // Cognito requires an EXACT match against a registered callback URL — the web app
        // (apps/web/src/auth/authConfig.ts's redirectUri) always sends
        // `${origin}/auth/callback`, never the bare origin, so the bare origins alone here
        // would make every real Hosted-UI sign-in fail with redirect_mismatch.
        callbackUrls: [
          ...webOrigins.map((origin) => `${origin}/auth/callback`),
          // Seed the custom-domain callback so a stage with empty extraWebOrigins (prod) still has a
          // non-empty callback list at CONSTRUCTION — CDK throws CallbackUrlEmptyCodeGrant on an empty
          // array for a code-grant client. The unconditional L1 override below (~:1171) replaces this
          // whole array in the final template, so every stage (beta included) synthesizes byte-identical.
          ...(webDomain ? [`https://${webDomain.domainName}/auth/callback`] : []),
        ],
        // Papercut 6 (M9 hardening): the app's signOut (apps/web/src/auth/useAuth.ts) now
        // redirects through Cognito's /logout endpoint to actually end the Hosted UI's own
        // session (clearing local tokens alone left it alive, so the next signIn() silently
        // resumed the same account) — `logout_uri` must EXACTLY match a registered value here,
        // same "Cognito requires an exact match" rule as callbackUrls above. authConfig.ts's
        // buildLogoutUrl always sends `${origin}/` (trailing slash, no path), not the bare
        // origin callbackUrls' own `/auth/callback` needs.
        logoutUrls: [
          ...webOrigins.map((origin) => `${origin}/`),
          ...(webDomain ? [`https://${webDomain.domainName}/`] : []),
        ],
      },
      // Prod-only (conditional spread → beta's synth is byte-identical): CDK omits the property
      // entirely when absent, so beta relies on Cognito's server-side default while prod pins ENABLED.
      ...(props.preventUserExistenceErrors ? { preventUserExistenceErrors: true } : {}),
    });

    const userPoolDomain = new UserPoolDomain(this, "UserPoolDomain", {
      userPool,
      cognitoDomain: { domainPrefix: `swng-${stage}-${this.account}` },
      // Managed login v2 (the branding designer's experience), painted by the
      // CfnManagedLoginBranding below — same OAuth endpoints/domain URL as v1, only the rendered
      // sign-in pages change (so authConfig.ts and the CSP are untouched).
      managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // The swng-branded managed login style (docs/superpowers/specs/2026-07-23-managed-login-brand-
    // and-brand-tokens-design.md). Settings + the wordmark logo are built from @swng/brand — the
    // login's colors ARE the same tokens the web renders. Partial Settings: Cognito merges its own
    // defaults for everything we don't specify.
    new CfnManagedLoginBranding(this, "ManagedLoginBranding", {
      userPoolId: userPool.userPoolId,
      clientId: userPoolClient.userPoolClientId,
      useCognitoProvidedValues: false,
      settings: managedLoginSettings,
      assets: managedLoginAssets,
    });

    // --- Participant-token signing secret ---------------------------------------------

    // Prod-readiness hardening Arc A, Task 4: this used to be a CDK-generated secret whose
    // plaintext was read at SYNTH TIME via `secretValue.unsafeUnwrap()` and baked directly
    // into the Lambdas' environment — readable by anyone with only
    // lambda:GetFunctionConfiguration, with no audit trail and no rotation without a
    // redeploy. The secret VALUE and its generation are UNCHANGED (same
    // `swng-token-secret-<stage>` secret, same live tokens keep verifying); only DELIVERY
    // changes — the ARN rides in the env now, and each app-building function fetches the
    // value itself at runtime (below, `grantRead`), narrowing the read population to an
    // audited secretsmanager:GetSecretValue grant and enabling rotation with no redeploy.
    const tokenSecret = new Secret(this, "TokenSecret", {
      secretName: `swng-token-secret-${stage}`,
      generateSecretString: { passwordLength: 40, excludePunctuation: true },
    });

    // --- Lambda functions (packages/lambda/src/entries/*.ts) ---------------------------
    //
    // WS_ENDPOINT is a genuine circular dependency: every entry's composition root
    // (compositionRoot.ts) requires it unconditionally, but its value (the WebSocketStage's
    // callback URL) doesn't exist until the WebSocketApi/Stage below are constructed — and
    // that construction needs wsConnectFn/wsDisconnectFn as integration targets. Broken by
    // constructing the functions first without WS_ENDPOINT, then back-filling it with
    // `addEnvironment` once the stage exists (below).

    const sharedEnv = {
      TABLE_ROUNDS: roundsTable.tableName,
      TABLE_CONNECTIONS: connectionsTable.tableName,
      // Task 4: the ARN only — never the value (compositionRoot.ts's buildApp fetches it at
      // runtime via @swng/adapters-secretsmanager, cached once per cold start).
      TOKEN_SECRET_ARN: tokenSecret.secretArn,
      // Prod-readiness Arc B Task 2: labels the EMF metrics' Stage dimension (compositionRoot.ts's
      // buildApp reads it, `?? "beta"` if absent) — beta/prod metrics stay apart in CloudWatch.
      STAGE: stage,
    };

    const makeFunction = (name: string, entryName: string): NodejsFunction =>
      new NodejsFunction(this, name, {
        entry: entryPath(entryName),
        handler: "handler",
        runtime: Runtime.NODEJS_20_X,
        environment: sharedEnv,
        // Explicit, not CDK's 3s default: createDynamoEventJournal's append path can need
        // several sequential Query+TransactWrite round trips under a hot write burst (its own
        // full-jitter backoff can itself sleep close to 1s per collision), and the 3s default
        // was independently truncating in-flight retries before MAX_APPEND_ATTEMPTS would have
        // (task-6-report.md). 512MB matches the workload (JSON in/out, no heavy compute) while
        // giving a bit more CPU share than the 128MB default for esbuild-bundled cold starts.
        timeout: Duration.seconds(15),
        memorySize: 512,
      });

    const httpFn = makeFunction("HttpFunction", "http");
    const wsConnectFn = makeFunction("WsConnectFunction", "wsConnect");
    const wsDisconnectFn = makeFunction("WsDisconnectFunction", "wsDisconnect");

    // TABLE_CORE only goes to httpFn: the course routes (M6) are HTTP-only — wsConnect/
    // wsDisconnect never touch the core table, unlike TABLE_ROUNDS/TABLE_CONNECTIONS above
    // which every function needs (round broadcast / connection bookkeeping respectively).
    httpFn.addEnvironment("TABLE_CORE", coreTable.tableName);
    // M7 Task 4: TABLE_PROJECTIONS + the Cognito identifiers httpFn's "golfer" auth tier
    // (lambda/http/dispatch.ts) needs to build a real CognitoVerifier — wsConnect/
    // wsDisconnect never dispatch a golfer-tier route, same reasoning as TABLE_CORE above.
    // No golfer/record route reads projections yet (that lands in a later task), but the
    // grant + env land now so that task is route-wiring only, not another CDK change.
    httpFn.addEnvironment("TABLE_PROJECTIONS", projectionsTable.tableName);
    httpFn.addEnvironment("USER_POOL_ID", userPool.userPoolId);
    httpFn.addEnvironment("USER_POOL_CLIENT_ID", userPoolClient.userPoolClientId);
    // Snapshot realignment Task 1: forward-provisioned ahead of the transactional finalize (a
    // later task) that makes httpFn the snapshots table's sole writer — same "grant + env land
    // now so that task is route-wiring only" idiom as TABLE_PROJECTIONS above.
    httpFn.addEnvironment("TABLE_SNAPSHOTS", snapshotsTable.tableName);

    // ProjectorFunction (the snapshots table's stream, unfiltered — snapshot realignment Task
    // 1) and RebuildFunction (manual invoke only — no event source) are their own minimal
    // NodejsFunctions, not built via makeFunction above: neither needs TABLE_CONNECTIONS,
    // TOKEN_SECRET_ARN, or WS_ENDPOINT (they never broadcast or touch a participant token), so
    // giving them `sharedEnv` would leak table names/the secret's ARN into a Lambda console
    // that has no reason to see them (and, per Task 4's grants below, neither role can read
    // the secret's value even if it did).
    const projectorFn = new NodejsFunction(this, "ProjectorFunction", {
      entry: entryPath("projector"),
      handler: "handler",
      runtime: Runtime.NODEJS_20_X,
      // TABLE_SNAPSHOTS is deliberately absent: the projector reads nothing by table name from
      // the snapshots table — parseSnapshotStreamImage unmarshalls the archive straight out of
      // the stream record the event source below hands it. TABLE_CORE, by contrast, IS needed
      // (accounts-only identity spec §7): projectArchive reads each participant's golfer row (the
      // golfer store lives on the core table) to project only account-bound golfers.
      environment: { TABLE_PROJECTIONS: projectionsTable.tableName, TABLE_CORE: coreTable.tableName },
      timeout: Duration.seconds(15),
      memorySize: 512,
    });
    const rebuildFn = new NodejsFunction(this, "RebuildFunction", {
      entry: entryPath("rebuild"),
      handler: "handler",
      runtime: Runtime.NODEJS_20_X,
      // Snapshot realignment Task 1: TABLE_ROUNDS is gone — the rebuild never touches the
      // rounds table again (it backfills by paging the snapshots table). TABLE_CORE joins here
      // (accounts-only identity spec §7): the backfill replays through the SAME projectArchive
      // the stream trigger uses, which reads each participant's golfer row.
      environment: {
        TABLE_PROJECTIONS: projectionsTable.tableName,
        TABLE_SNAPSHOTS: snapshotsTable.tableName,
        TABLE_CORE: coreTable.tableName,
      },
      // Longer than the other functions' fixed 15s budget on purpose: this replays every
      // snapshot in one invocation, not a single request — an operator-triggered job, not a
      // hot path.
      timeout: Duration.minutes(5),
      memorySize: 512,
    });

    // D4b (pre-prod hardening spec): a deterministically-throwing stream record must not block
    // its shard retrying for 24h and then vanish with its batchmates. Bisect isolates the poison
    // record, bounded retries hand it to the DLQ, and the DLQ alarm below pages. NOTE the DLQ
    // message is stream METADATA (shard + sequence range), not the record payload — recovery is:
    // fix the bug, then re-drive the affected range with rebuildProjections (already
    // paged/cursor-resumable). The queue is a signal + bookmark, never a replay source — which
    // is also why it keeps the default DESTROY removal policy while the stateful tables all pin
    // RETAIN: everything in it is re-derivable.
    const projectorDlq = new Queue(this, "ProjectorDlq", {
      queueName: `swng-projector-dlq-${stage}`,
      retentionPeriod: Duration.days(14),
    });

    // Snapshot realignment Task 1 / spec §2 ("no filter, no branching"): sourced from the
    // snapshots table's own stream now, not the rounds table's — every item there already IS a
    // finished round, so the ARCHIVE-only FilterCriteria this used to carry is deleted outright,
    // not narrowed.
    projectorFn.addEventSource(
      new DynamoEventSource(snapshotsTable, {
        startingPosition: StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        bisectBatchOnError: true,
        retryAttempts: 10,
        onFailure: new SqsDlq(projectorDlq),
      }),
    );

    // --- WebSocket API ($connect / $disconnect only — no $default route: every WS message
    // this system sends is server -> client broadcast, never client -> server) -----------

    const webSocketApi = new WebSocketApi(this, "WebSocketApi", {
      apiName: `swng-ws-${stage}`,
      connectRouteOptions: { integration: new WebSocketLambdaIntegration("WsConnectIntegration", wsConnectFn) },
      disconnectRouteOptions: { integration: new WebSocketLambdaIntegration("WsDisconnectIntegration", wsDisconnectFn) },
    });
    const webSocketStage = new WebSocketStage(this, "WebSocketStage", {
      webSocketApi,
      stageName: stage,
      autoDeploy: true,
    });

    // Now that the stage (and its callback URL) exists, complete every function's env.
    for (const fn of [httpFn, wsConnectFn, wsDisconnectFn]) {
      fn.addEnvironment("WS_ENDPOINT", webSocketStage.callbackUrl);
    }

    // --- HTTP API ------------------------------------------------------------------------

    // Prod-readiness hardening Arc A, Task 6: CORS scoped off "*" to the real web origins.
    // TRAP avoided deliberately: this list must NEVER reference
    // `distribution.distributionDomainName` — the distribution (built later, below) embeds a
    // CSP built from httpApi.apiEndpoint via its own responseHeadersPolicy, so the distribution
    // already depends on httpApi; folding the distribution's domain token back into httpApi's
    // OWN CORS config would be a genuine circular dependency (distribution -> CSP -> httpApi ->
    // distribution) that fails `cdk synth`. The raw cloudfront.net origin below is a hand-known
    // literal instead (the stable URL M9 Task 6 first stood up, still live) — a plain string,
    // not a token read off the distribution construct, so it carries no dependency at all.
    // Beta's own cloudfront.net is hardcoded here (not read off the distribution) because CORS is
    // computed before the distribution exists — a token here would cycle (Arc A note). Per-stage
    // via extraCorsOrigins: prod passes [] (prod users reach it at swng.golf, not the raw CDN name).
    const extraCorsOrigins = props.extraCorsOrigins ?? ["https://d5qqgppnyb7y1.cloudfront.net"];
    const corsAllowOrigins = [
      ...webOrigins,
      ...extraCorsOrigins,
      // Cycle-free: webDomain is `props.web`, a plain string supplied at synth time by
      // bin/infra-cdk.ts's STAGE_WEB table — never a token derived from another construct in
      // this stack (unlike the forbidden distribution-domain reference above).
      ...(webDomain ? [`https://${webDomain.domainName}`] : []),
    ];

    const httpApi = new HttpApi(this, "HttpApi", {
      apiName: `swng-http-${stage}`,
      corsPreflight: {
        allowOrigins: corsAllowOrigins,
        // Every method HTTP_ROUTES uses must be allowed here too — a route whose method is
        // missing still answers curl, but a browser's preflight gets a 204 with NO
        // access-control-allow-* headers and the actual request is blocked (verified live
        // against beta, M7 Task 5). PUT joined for PUT /me; the stack test pins this list as
        // a superset of HTTP_ROUTES' own method set so the next new method can't ship
        // browser-dead.
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.PUT, CorsHttpMethod.DELETE],
        allowHeaders: ["content-type", "authorization"],
      },
    });
    const httpIntegration = new HttpLambdaIntegration("HttpIntegration", httpFn);
    for (const route of HTTP_ROUTES) {
      httpApi.addRoutes({ path: route.path, methods: [route.method], integration: httpIntegration });
    }

    // --- Throttling (M9 Task 5) -----------------------------------------------------------
    //
    // Abuse ceilings, not capacity planning: a real Saturday crew's whole round generates on
    // the order of 1 request/sec (a handful of golfers tapping scores between shots). 50 rps /
    // 100 burst on the stage default leaves a hundredfold headroom above that while still
    // bounding a runaway client or a scripted flood. The 8 anonymous-reachable routes
    // (ANON_THROTTLED_ROUTES above) get a tighter ceiling — no participant/golfer token to make
    // minting expensive first — at a tenth of the stage default: still ~5x a Saturday crew's own
    // rate, but nowhere near enough headroom for a script to mint thousands of rounds/courses a
    // minute.
    const STAGE_THROTTLE_RATE_LIMIT = 50;
    const STAGE_THROTTLE_BURST_LIMIT = 100;
    const ANON_ROUTE_THROTTLE_RATE_LIMIT = 5;
    const ANON_ROUTE_THROTTLE_BURST_LIMIT = 10;

    // apigatewayv2's L2 HttpApi/HttpStage constructs expose NO throttle knob anywhere on the
    // auto-created default stage — HttpApiProps carries no `throttle` field at all (only
    // `addStage`'s own HttpStageOptions does, and that's for a NEW stage this code doesn't
    // create; replacing the existing default stage with one built via addStage would change its
    // logical id, and therefore its physical resource — exactly what the deploy policy forbids).
    // The default stage's underlying CfnStage resource DOES support both `defaultRouteSettings`
    // (whole-stage default) and `routeSettings` (a "METHOD /path" -> {rate, burst} map — the
    // documented per-route mechanism, AWS::ApiGatewayV2::Stage's own RouteSettings property) —
    // so this reaches through the L2's own defaultChild (the L1 escape hatch) rather than
    // replacing the stage construct, keeping its logical id — and the already-deployed stage's
    // physical id — untouched.
    if (!httpApi.defaultStage) {
      throw new Error("HttpApi has no defaultStage — createDefaultStage must stay true for the throttle escape hatch below to apply");
    }
    const defaultStageResource = httpApi.defaultStage.node.defaultChild as CfnStage;
    // `defaultRouteSettings` is a strongly-typed `CfnStage.RouteSettingsProperty` — its own
    // camelCase properties (`throttlingRateLimit`/`throttlingBurstLimit`) go through a real
    // property mapper that PascalCases them into the template.
    defaultStageResource.defaultRouteSettings = {
      throttlingRateLimit: STAGE_THROTTLE_RATE_LIMIT,
      throttlingBurstLimit: STAGE_THROTTLE_BURST_LIMIT,
    };
    // `routeSettings`, by contrast, is typed `any` (CDK's own generated escape hatch for this
    // property — verified against aws-cdk-lib's generated mapper: RouteSettings goes through
    // `objectToCloudFormation`, which is a bare identity function, not a property mapper) — so
    // unlike defaultRouteSettings above, nothing here PascalCases nested keys automatically.
    // The exact CloudFormation property names (ThrottlingRateLimit/ThrottlingBurstLimit) must be
    // supplied directly, and the outer keys must be real route keys ("METHOD /path", matching
    // AWS::ApiGatewayV2::Route's own RouteKey format used elsewhere in this file).
    defaultStageResource.routeSettings = Object.fromEntries(
      ANON_THROTTLED_ROUTES.map((route) => [
        `${route.method} ${route.path}`,
        { ThrottlingRateLimit: ANON_ROUTE_THROTTLE_RATE_LIMIT, ThrottlingBurstLimit: ANON_ROUTE_THROTTLE_BURST_LIMIT },
      ]),
    );
    // RouteSettings references routes by KEY, not by CloudFormation ref — so nothing above
    // gives CloudFormation an ordering edge between this stage update and the Route resources
    // themselves. The first deploy that added a BRAND-NEW route to ANON_THROTTLED_ROUTES
    // (crew membership's POST /crews/peek) proved it the hard way: the stage update ran before
    // the route existed, API Gateway 404'd the unknown route key, and the stack wedged in
    // UPDATE_ROLLBACK_FAILED (recovered via continue-update-rollback --resources-to-skip).
    // This explicit dependency on every route resource is the structural fix: the stage's
    // settings never apply until every route they could name exists.
    for (const child of httpApi.node.findAll()) {
      if (CfnRoute.isCfnResource(child) && child.cfnResourceType === "AWS::ApiGatewayV2::Route") {
        defaultStageResource.addDependency(child as CfnRoute);
      }
    }

    // --- Grants ---------------------------------------------------------------------------

    roundsTable.grantReadWriteData(httpFn);
    coreTable.grantReadWriteData(httpFn);
    connectionsTable.grantReadWriteData(httpFn);
    connectionsTable.grantReadWriteData(wsConnectFn);
    connectionsTable.grantReadWriteData(wsDisconnectFn);
    // Snapshot realignment Task 1: the finalize transaction (a later task) writes the snapshot
    // through httpFn — read+write, mirroring roundsTable's own grant above (httpFn also reads
    // a snapshot back for the archived-round view, another later task).
    snapshotsTable.grantReadWriteData(httpFn);
    // Only `http` broadcasts (adapters-apigateway's createApiGatewayBroadcast, wired in
    // compositionRoot.ts) — wsConnect/wsDisconnect never call PostToConnection.
    webSocketApi.grantManageConnections(httpFn);
    // Task 4: every function that builds the whole app (buildApp, compositionRoot.ts) needs
    // secretsmanager:GetSecretValue on this ONE secret — httpFn/wsConnectFn/wsDisconnectFn,
    // the same three functions makeFunction constructed above (never projectorFn/rebuildFn,
    // which don't call buildApp and never carry TOKEN_SECRET_ARN in their env at all).
    for (const fn of [httpFn, wsConnectFn, wsDisconnectFn]) {
      tokenSecret.grantRead(fn);
    }

    // M7 Task 4: the projections table's readers/writers. projectorFn's stream READ access
    // (GetRecords/DescribeStream/etc. on the snapshots table's stream, snapshot realignment
    // Task 1) is granted automatically by addEventSource above (DynamoEventSource.bind calls
    // table.grantStreamRead) — it needs no separate grant call here.
    projectionsTable.grantReadWriteData(projectorFn);
    projectionsTable.grantReadWriteData(rebuildFn);
    projectionsTable.grantReadWriteData(httpFn);
    // Snapshot realignment Task 1: rebuild now reads the snapshots table instead of the rounds
    // table (the rebuild never touches the rounds table again — its own TABLE_ROUNDS grant and
    // env are gone, not just narrowed).
    snapshotsTable.grantReadData(rebuildFn);
    // Accounts-only identity (spec §7): the projector and rebuild read each participant's golfer
    // row (on the core table) to project ONLY account-bound golfers — read-only, they never write
    // golfer/course/crew data. httpFn already has read+write on the core table (above).
    coreTable.grantReadData(projectorFn);
    coreTable.grantReadData(rebuildFn);

    // --- Alarms -> one SNS topic (M9 Task 5) -----------------------------------------------
    //
    // One topic, one email subscription — every alarm below fires into the SAME topic so the
    // owner gets one inbox to watch, not five. The email subscription itself needs a
    // confirmation click (SNS's own protocol) — that's a real human action after deploy, not
    // something this stack (or a deploy script) can complete on the owner's behalf.
    const alarmsTopic = new Topic(this, "AlarmsTopic", { topicName: `swng-alarms-${stage}` });
    alarmsTopic.addSubscription(new EmailSubscription("interrante.blaine@gmail.com"));

    // Every alarm constructed below is routed through this — wiring the SAME action everywhere
    // is what "all alarms -> one topic" means structurally, not just "they happen to share a
    // topic reference."
    const paged = (alarm: Alarm): Alarm => {
      alarm.addAlarmAction(new SnsAction(alarmsTopic));
      return alarm;
    };

    // Like paged(), but also notifies on return-to-OK — for the sustained HTTP alarms where
    // "it recovered on its own" is information the owner wants (not so for DLQ/IteratorAge, which
    // need a human-run rebuild/redrive and stay alarm-only).
    const pagedWithRecovery = (alarm: Alarm): Alarm => {
      alarm.addAlarmAction(new SnsAction(alarmsTopic));
      alarm.addOkAction(new SnsAction(alarmsTopic));
      return alarm;
    };

    const FIVE_MINUTES = Duration.minutes(5);

    // Non-transient 5xx: sustained server errors, not a single deploy blip. 2 of the last 3
    // five-minute windows each at >= 10 5xx. OK-notifying so the owner learns when it recovers.
    pagedWithRecovery(
      new Alarm(this, "HttpApi5xxAlarm", {
        alarmDescription: "HTTP API: >= 10 5xx responses in 2 of the last 3 five-minute windows (sustained server errors)",
        metric: httpApi.metricServerError({ period: FIVE_MINUTES, statistic: "Sum" }),
        threshold: 10,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    // p95 latency > 3s, 2 of 3 windows. API Gateway emits Latency for free; no latency alarm
    // existed before Arc B. OK-notifying, same rationale as the 5xx alarm.
    pagedWithRecovery(
      new Alarm(this, "HttpApiP95LatencyAlarm", {
        alarmDescription: "HTTP API: p95 latency over 3000ms in 2 of the last 3 five-minute windows",
        metric: httpApi.metricLatency({ period: FIVE_MINUTES, statistic: "p95" }),
        threshold: 3000,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    // Projector stream IteratorAge > 5 minutes — the projections table (golfer index/history)
    // is falling behind the snapshots table's own stream. aws-lambda's Function/NodejsFunction
    // class exposes metricErrors/metricDuration/metricThrottles but NO metricIteratorAge helper
    // (verified against function-base.d.ts) — this is the documented AWS/Lambda namespace
    // metric, dimensioned by FunctionName alone (unambiguous here: projectorFn has exactly one
    // stream event source, wired above).
    paged(
      new Alarm(this, "ProjectorIteratorAgeAlarm", {
        alarmDescription: "ProjectorFunction: stream IteratorAge over 5 minutes — the projector is falling behind the snapshots table's stream",
        metric: new Metric({
          namespace: "AWS/Lambda",
          metricName: "IteratorAge",
          dimensionsMap: { FunctionName: projectorFn.functionName },
          period: FIVE_MINUTES,
          statistic: "Maximum",
        }),
        threshold: FIVE_MINUTES.toMilliseconds(),
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    // D4b: a non-empty DLQ means a poisoned snapshots-stream record needs a human — page on ANY
    // depth above zero (not a batch-sized threshold), since even one message means that record's
    // projections are stuck until the fix-then-rebuildProjections cycle above runs.
    paged(
      new Alarm(this, "ProjectorDlqDepthAlarm", {
        alarmDescription:
          "ProjectorFunction: a poisoned snapshots-stream record landed in the DLQ — that record's projections are NOT applied until rebuildProjections re-drives them after the fix",
        metric: projectorDlq.metricApproximateNumberOfMessagesVisible({ period: FIVE_MINUTES, statistic: "Maximum" }),
        threshold: 0,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    // Rebuild Duration > 4 minutes — the 5-minute-timeout tripwire (rebuildFn's own CDK timeout,
    // set above): a full-table replay of every finalized round's projections that's still
    // running at 4 minutes is heading for a hard cutoff at 5, so the owner gets a page with a
    // minute of runway left to investigate rather than only learning about it from the timeout
    // itself (or a silently incomplete rebuild).
    paged(
      new Alarm(this, "RebuildDurationAlarm", {
        alarmDescription: "RebuildFunction: an invocation ran over 4 minutes — approaching its own 5-minute hard timeout",
        metric: rebuildFn.metricDuration({ period: FIVE_MINUTES, statistic: "Maximum" }),
        threshold: Duration.minutes(4).toMilliseconds(),
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    // --- Abuse-shape alarms (Arc B) -------------------------------------------------------
    //
    // Two cheap signals for the account -> crew -> round abuse chain. (1) The WAF is actively
    // blocking a flood right now (reads the Arc A rate-rule metrics — no app code). (2) A signup
    // burst that stays under the per-IP WAF rate (reads the Signups EMF metric).
    //
    // VERIFIED live against deployed swng-beta (`aws cloudwatch list-metrics --namespace
    // AWS/WAFV2`, whole-branch review 2026-07-23/24): the `WebACL` dimension value must be the
    // ACL's actual NAME (below: `WebAclCloudfront`/`WebAclCognito` now carry an explicit `name`
    // matching these strings — see the CfnWebACL constructs further down, where the comment
    // explains WHY this is now deterministic rather than CFN-generated). The CLOUDFRONT-scope
    // ACL's metric carries NO `Region` dimension at all (only `{WebACL, Rule}`); the REGIONAL
    // Cognito ACL's metric DOES carry `Region: "us-east-1"`. `Rule: "ALL"` is the ACL-level
    // aggregate for both. `region` is now optional and omitted entirely (not "Global") for the
    // CloudFront leg — passing "Global" was the original bug: it doesn't match any real
    // dimension WAFv2 emits, so that leg's metric could never return data.
    const wafBlocked = (webAcl: string, region?: string): Metric =>
      new Metric({
        namespace: "AWS/WAFV2",
        metricName: "BlockedRequests",
        dimensionsMap: { WebACL: webAcl, Rule: "ALL", ...(region ? { Region: region } : {}) },
        period: FIVE_MINUTES,
        statistic: "Sum",
      });
    paged(
      new Alarm(this, "WafBlockedRequestsAlarm", {
        alarmDescription: "WAF: over 100 requests blocked by the rate rules in 5 minutes — a flood is in progress",
        metric: new MathExpression({
          expression: "cf + cognito",
          usingMetrics: {
            cf: wafBlocked(`swng-waf-cf-${stage}`),
            cognito: wafBlocked(`swng-waf-cognito-${stage}`, "us-east-1"),
          },
          period: FIVE_MINUTES,
        }),
        threshold: 100,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );
    paged(
      new Alarm(this, "SignupSpikeAlarm", {
        alarmDescription: "Signups: 50 or more new golfer accounts in 5 minutes — a possible account-creation abuse spike",
        metric: new Metric({
          namespace: "swng",
          metricName: "Signups",
          dimensionsMap: { Stage: stage },
          period: FIVE_MINUTES,
          statistic: "Sum",
        }),
        threshold: 50,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    // --- Ops dashboard (Arc B) ------------------------------------------------------------
    //
    // One pane: "how's swng doing." Business volumes (EMF), HTTP latency/errors, projector
    // health, WAF, and a Logs Insights widget over the http access log for DAU + per-route.
    const swngCount = (name: string): Metric =>
      new Metric({ namespace: "swng", metricName: name, dimensionsMap: { Stage: stage }, period: Duration.days(1), statistic: "Sum" });

    const dashboard = new Dashboard(this, "OpsDashboard", { dashboardName: `swng-ops-${stage}` });
    dashboard.addWidgets(
      new GraphWidget({
        title: "Business — rounds & signups (daily)",
        left: [swngCount("RoundsCreated"), swngCount("RoundsFinalized"), swngCount("Signups"), swngCount("LateScoreRefused")],
        width: 12,
      }),
      new GraphWidget({
        title: "HTTP latency (p50/p95/p99)",
        left: [
          httpApi.metricLatency({ period: FIVE_MINUTES, statistic: "p50" }),
          httpApi.metricLatency({ period: FIVE_MINUTES, statistic: "p95" }),
          httpApi.metricLatency({ period: FIVE_MINUTES, statistic: "p99" }),
        ],
        width: 12,
      }),
      new GraphWidget({
        title: "HTTP errors (4xx / 5xx)",
        left: [
          httpApi.metricClientError({ period: FIVE_MINUTES, statistic: "Sum" }),
          httpApi.metricServerError({ period: FIVE_MINUTES, statistic: "Sum" }),
        ],
        width: 12,
      }),
      new GraphWidget({
        title: "Projector health",
        left: [
          new Metric({ namespace: "AWS/Lambda", metricName: "IteratorAge", dimensionsMap: { FunctionName: projectorFn.functionName }, period: FIVE_MINUTES, statistic: "Maximum" }),
        ],
        right: [projectorDlq.metricApproximateNumberOfMessagesVisible({ period: FIVE_MINUTES, statistic: "Maximum" })],
        width: 12,
      }),
      new GraphWidget({
        title: "WAF (blocked requests)",
        left: [wafBlocked(`swng-waf-cf-${stage}`), wafBlocked(`swng-waf-cognito-${stage}`, "us-east-1")],
        width: 12,
      }),
      // Split from a single combined widget (whole-branch review, 2026-07-23/24): the original
      // query grouped `count_distinct(sub) as activeGolfers` BY route alongside `count(*) as
      // requests`, so `activeGolfers` was actually per-route active golfers, double-counting
      // anyone active on more than one route — not a real daily-active figure. Two widgets, two
      // honest queries: one true DAU-shaped count (no route grouping), one requests-by-route
      // breakdown (no activeGolfers claim).
      new LogQueryWidget({
        title: "Unique active golfers (by day)",
        logGroupNames: [httpFn.logGroup.logGroupName],
        queryLines: ['filter message = "request"', "stats count_distinct(sub) as activeGolfers by bin(1d)"],
        width: 12,
      }),
      new LogQueryWidget({
        title: "Requests by route",
        logGroupNames: [httpFn.logGroup.logGroupName],
        queryLines: ['filter message = "request"', "stats count(*) as requests by route", "sort requests desc"],
        width: 12,
      }),
    );

    // --- WAF rate-limiting (Prod-readiness hardening Arc A, Task 5) -----------------------
    //
    // Chokes the head of the abuse chain — accounts (Cognito) -> crews -> rounds. A per-route
    // API Gateway throttle (above) already bounds request RATE once a client has a token; this
    // adds a per-IP ceiling in front of the two places an attacker can act with NO token at
    // all: minting Cognito accounts, and hitting the CloudFront-fronted web app itself.
    //
    // TWO WebACLs, not one — CloudFront and Cognito are different WAF SCOPES and attach
    // differently: a CLOUDFRONT-scope ACL is wired via the Distribution's own `webAclId` prop
    // (never an association — CloudFront doesn't support WebACLAssociation), and a REGIONAL-scope
    // ACL is wired via a real CfnWebACLAssociation onto the user pool's ARN (a user pool is a
    // REGIONAL WAF resource; a CLOUDFRONT-scope ACL cannot be associated to it). Distinct logical
    // ids, distinct `metricName`s (CloudWatch metric names must be unique per ACL), and distinct
    // rule metric names below — these four names are also the exact strings a future abuse-shape
    // alarm (Arc B) will read off CloudWatch.
    //
    // A CLOUDFRONT-scope WebACL must be created in us-east-1 — this stack IS us-east-1
    // (bin/infra-cdk.ts), so no separate region-pinned stack is needed.
    const RATE_LIMIT_PER_5MIN = 2000; // generous vs a real crew (~1 rps); tune down if telemetry shows floods

    const rateLimitRule = (metricName: string): CfnWebACL.RuleProperty => ({
      name: "RateLimit",
      priority: 0,
      action: { block: {} },
      statement: { rateBasedStatement: { aggregateKeyType: "IP", limit: RATE_LIMIT_PER_5MIN } },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName, sampledRequestsEnabled: true },
    });

    // `name` is explicit on both ACLs below (whole-branch review, 2026-07-23/24, verified live
    // against deployed swng-beta via `aws cloudwatch list-metrics --namespace AWS/WAFV2`): left
    // unset, WAFv2 mints a CFN-generated name (e.g. `WebAclCloudfront-krOJ9wnLG35T`), and the
    // CloudWatch metric's `WebACL` dimension carries THAT generated name, not the
    // `visibilityConfig.metricName` string (which WAFv2 surfaces as the `Rule` dimension
    // instead) — so `wafBlocked` above could never have matched real data no matter what it
    // passed. Pinning `name` here makes the ACL's real name equal to the metric-name strings
    // `wafBlocked`'s call sites already use, closing the gap. NOTE: `Name` is a REPLACEMENT
    // property on AWS::WAFv2::WebACL — this deploy replaces both ACLs. Benign on beta:
    // CloudFront reattaches via `webAclId` and Cognito via its `CfnWebACLAssociation`, both
    // already re-resolved from the (new) ACL's ARN on every synth.
    const cloudfrontWebAcl = new CfnWebACL(this, "WebAclCloudfront", {
      name: `swng-waf-cf-${stage}`,
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `swng-waf-cf-${stage}`, sampledRequestsEnabled: true },
      rules: [rateLimitRule(`swng-waf-cf-rate-${stage}`)],
    });

    const cognitoWebAcl = new CfnWebACL(this, "WebAclCognito", {
      name: `swng-waf-cognito-${stage}`,
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `swng-waf-cognito-${stage}`, sampledRequestsEnabled: true },
      rules: [rateLimitRule(`swng-waf-cognito-rate-${stage}`)],
    });
    new CfnWebACLAssociation(this, "CognitoWebAclAssociation", {
      resourceArn: userPool.userPoolArn,
      webAclArn: cognitoWebAcl.attrArn,
    });

    // --- Hosted web (M9 Task 6): S3 + CloudFront, so the app is reachable from a phone -----
    //
    // The bucket holds only re-publishable Vite build output (apps/web/dist, synced by
    // scripts/publishWeb.mjs on every `pnpm publish:web:beta`) — never irreplaceable data,
    // unlike the tables/pool above which stay RETAIN. DESTROY + autoDeleteObjects is the
    // right removal policy here: the bucket is never empty in practice (a fresh sync always
    // repopulates it immediately), so RETAIN or bare DESTROY would either leak the bucket
    // forever or make `cdk destroy` fail outright on a non-empty bucket — autoDeleteObjects
    // is what actually makes "destroy this stack" work.
    const webBucket = new Bucket(this, "WebBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // The ONLY reader is CloudFront via Origin Access Control below — no public access, no
      // website-hosting endpoint.
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    // The CSP's connect-src origins, read from this stack's own live constructs — never
    // hardcoded, so a redeploy that changes any of these (a new HTTP API domain, e.g.) can't
    // silently leave the CSP pointing at a stale origin. httpApi.apiEndpoint and
    // userPoolDomain.baseUrl() already carry `https://`; webSocketStage.url already carries
    // `wss://` (confirmed against the existing WsApiUrl output above / cdk-outputs.json) — none
    // need a scheme prefixed here.
    const contentSecurityPolicy = [
      "default-src 'self'",
      `connect-src 'self' ${httpApi.apiEndpoint} ${webSocketStage.url} ${userPoolDomain.baseUrl()}`,
      // No third-party script origin exists anywhere in this app (the load-bearing fact behind
      // M9's localStorage-token re-acceptance) — 'self' only, no CDN/analytics allowance.
      "script-src 'self'",
      // Tailwind emits inline <style> at runtime — style-src needs 'unsafe-inline' or the app
      // renders unstyled.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      // Task 6: no OTHER site may frame this app (clickjacking defense-in-depth alongside the
      // FrameOptions header below), and no injected <base> tag can retarget this app's
      // relative URLs at an attacker's origin.
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join("; ");

    // Task 6 (edge hardening): the CSP above was the only security header this policy carried —
    // HSTS/nosniff/referrer/frame-options were simply absent from every response CloudFront
    // served. `override: true` on each (matching the CSP's own existing choice) means this
    // policy's value always wins over anything the origin (S3) might send, rather than merging.
    const webResponseHeadersPolicy = new ResponseHeadersPolicy(this, "WebResponseHeadersPolicy", {
      responseHeadersPolicyName: `swng-web-csp-${stage}`,
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
      },
    });

    // --- Custom domain (Task D-T1): cert + hosted zone, only when a domain is configured ---
    //
    // webDomain (resolved earlier, above the HTTP API's CORS scoping — Task 6) comes from the
    // per-stage config table in bin/infra-cdk.ts (D5's shape, starting here) — nothing in this
    // stack branches on the stage NAME itself. hostedZone is IMPORTED, not created: swng.golf's
    // zone already exists (and, until D-T2's controller-run handover, still holds the POC's own
    // beta.swng.golf A record — Global Constraints) — this stack only ever appends its own
    // alias records into it below, never claims ownership.
    const hostedZone = webDomain
      ? HostedZone.fromHostedZoneAttributes(this, "WebZone", { hostedZoneId: webDomain.hostedZoneId, zoneName: webDomain.zoneName })
      : undefined;
    // A BRAND NEW certificate — the POC's own already-issued cert for beta.swng.golf is
    // deliberately NOT referenced or reused (Global Constraints: lifecycle independence — this
    // stack's cert must be destroyable/replaceable without any dependency on the POC's own
    // resources). DNS validation UPSERTs its validation CNAME into the hosted zone; ACM's
    // per-account-per-domain validation record is identical to the one the POC's cert already
    // satisfies, so this cert validates immediately with no new manual DNS step required.
    const webCertificate =
      webDomain && hostedZone ? new Certificate(this, "WebCertificate", { domainName: webDomain.domainName, validation: CertificateValidation.fromDns(hostedZone) }) : undefined;

    const distribution = new Distribution(this, "WebDistribution", {
      defaultRootObject: "index.html",
      // Task 5: the CLOUDFRONT-scope WebACL built above — `webAclId` accepts the ACL's ARN
      // despite its name (the L2 Distribution prop's own documented contract).
      webAclId: cloudfrontWebAcl.attrArn,
      defaultBehavior: {
        // S3BucketOrigin.withOriginAccessControl creates a real Origin Access Control (the
        // modern replacement for the legacy Origin Access Identity) AND wires the bucket
        // policy that grants ONLY this distribution's OAC read access — no separate policy
        // wiring needed here.
        origin: S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: webResponseHeadersPolicy,
      },
      // SPA fallback: a client-side route with no matching S3 key (`/watch/:roundId`,
      // `/round/:id`, `/profile`, ...) surfaces from a private OAC-fronted bucket as 403 (S3's
      // "missing key" response through OAC is Access Denied, not 404) — so BOTH 403 and 404 map
      // to index.html with a 200, letting react-router's client-side routing take over instead
      // of the browser rendering a raw CloudFront error page.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
      // Task D-T1: the alias + its cert, ONLY when a domain is configured — the distribution's
      // OWN cloudfront.net URL (WebUrl output below) keeps resolving regardless (Global
      // Constraints: aliases are additive, never a replacement of the default domain). Spread
      // idiom, not a second Distribution prop object, so the construct's logical id (and
      // therefore its physical distribution / cloudfront.net URL) never changes because of this
      // prop being set or unset.
      ...(webDomain && webCertificate ? { domainNames: [webDomain.domainName], certificate: webCertificate } : {}),
    });

    // The alias records themselves — A (IPv4) and AAAA (IPv6; CloudFront is dual-stack, so
    // omitting this would leave IPv6 clients unable to resolve the domain at all), both alias-
    // targeting the distribution built just above. D-T2 (the controller-run live handover)
    // releases the alias from the POC's own distribution and deletes the POC's existing
    // beta.swng.golf A record BEFORE this stack's first real deploy of these records — until
    // then, a deploy would fail CNAMEAlreadyExists (Global Constraints) — but that sequencing
    // is a live, controller-run act, not stack code.
    if (webDomain && hostedZone) {
      const webAliasTarget = RecordTarget.fromAlias(new CloudFrontTarget(distribution));
      new ARecord(this, "WebAliasA", { zone: hostedZone, recordName: webDomain.domainName, target: webAliasTarget });
      new AaaaRecord(this, "WebAliasAaaa", { zone: hostedZone, recordName: webDomain.domainName, target: webAliasTarget });
    }

    // The distribution's domain is only known here — it's built from httpApi/webSocketStage
    // (constructed earlier, above), so it can't be folded into userPoolClient's ORIGINAL
    // callbackUrls/logoutUrls at construction time without a real circular dependency. Reached
    // through the L1 escape hatch instead (same idiom as the throttling section's CfnStage
    // reach-through above) to APPEND the CloudFront origin onto the SAME UserPoolClient
    // construct — unchanged logical id, an in-place property update (CallbackURLs/LogoutURLs
    // are mutable, non-replacing AWS::Cognito::UserPoolClient properties — the same fact M9
    // Task 2's own logoutUrls change already relied on), never a reconstruction. The existing
    // localhost entries stay untouched so dev keeps working.
    const cfnUserPoolClient = userPoolClient.node.defaultChild as CfnUserPoolClient;
    // Task D-T1: when a custom domain is configured, its callback/logout entries are APPENDED
    // onto these SAME arrays too — alongside localhost and the distribution-domain entries
    // above, never in place of them, so dev and the plain cloudfront.net URL both keep working
    // once beta.swng.golf goes live.
    cfnUserPoolClient.callbackUrLs = [
      ...webOrigins.map((origin) => `${origin}/auth/callback`),
      `https://${distribution.distributionDomainName}/auth/callback`,
      ...(webDomain ? [`https://${webDomain.domainName}/auth/callback`] : []),
    ];
    cfnUserPoolClient.logoutUrLs = [
      ...webOrigins.map((origin) => `${origin}/`),
      `https://${distribution.distributionDomainName}/`,
      ...(webDomain ? [`https://${webDomain.domainName}/`] : []),
    ];

    // --- MCP (swng-speaks-mcp design §6) --------------------------------------------------
    //
    // EVERYTHING in this block hangs off `props.mcp`. A stage without the prop (prod, this arc —
    // spec §10.4) synthesizes byte-identical to before the block existed, which is what the
    // existing prop-less template test proves; if that test ever fails, the gate leaked and the
    // fix is the gate, not the test.
    //
    // The whole design turns on ONE string. `canonical` is derived here, once, from the
    // configured host — the MCP endpoint URL, the Cognito resource server identifier, and the
    // PRM `resource` are all this expression (spec §4.3, measured F3: a Cognito resource server
    // identifier may carry a path). Drift between any two of them is not a loud failure: per F2
    // the authorization code is still issued, and then simply cannot be redeemed, reported as an
    // ordinary invalid_grant that points nowhere near the cause. test/mcpCanonical.test.ts reads
    // all of them back off the synthesized template for exactly that reason.
    const mcp = props.mcp;
    if (mcp) {
      const canonical = `https://${mcp.domainName}${MCP_ENDPOINT_PATH}`;

      // The OAuth mediation store (spec §6): registered clients, in-flight authorization
      // requests, held Cognito tokens awaiting consent, authorization codes, refresh handles —
      // one pk-only item shape for all five (adapters-dynamodb/src/keys.ts's oauth* prefixes).
      // DESTROY, alone among this stack's tables, and deliberately: every item here is
      // short-lived state a client re-creates by re-authorizing, so there is nothing to retain
      // (the same story connectionsTable tells). `ttl` is storage hygiene ONLY — DynamoDB deletes
      // on its own schedule, up to 48h late, so createDynamoOAuthStore checks `expiresAtMs` on
      // every read and never trusts the sweep.
      const oauthTable = new Table(this, "McpOAuthTable", {
        tableName: `swng-mcp-oauth-${stage}`,
        partitionKey: { name: "pk", type: AttributeType.STRING },
        billingMode: BillingMode.PAY_PER_REQUEST,
        removalPolicy: RemovalPolicy.DESTROY,
        timeToLiveAttribute: "ttl",
      });

      // Spec §4.2 F3: the identifier IS the canonical URI, path and all — that is the single
      // measured fact this whole design rests on. F5: a custom scope must belong to the resource
      // being requested, so both scopes are declared here and referenced through
      // OAuthScope.resourceServer below, which renders them as `<identifier>/read` and
      // `<identifier>/write` from this same construct. Never a second typed copy of either.
      const readScope = new ResourceServerScope({ scopeName: "read", scopeDescription: "Read your swng rounds, courses and crews" });
      const writeScope = new ResourceServerScope({ scopeName: "write", scopeDescription: "Record scores and manage your swng rounds" });
      const mcpResourceServer = userPool.addResourceServer("McpResourceServer", {
        identifier: canonical,
        userPoolResourceServerName: `swng-mcp-${stage}`,
        scopes: [readScope, writeScope],
      });

      // CONFIDENTIAL, unlike the web's public SPA client (spec §6). The secret is what makes
      // Cognito's own refresh token useless outside this stack, which is why /token can hand out
      // an opaque handle of its own instead of passing Cognito's through (spec §4.3).
      //
      // NOT `openid`: spec §4.3 requests neither an ID token nor OIDC scopes — `sub` is already
      // in the access token — and per F5 the custom scopes are the ones that must be attached
      // here for resource binding to work at all.
      const mcpUserPoolClient = new UserPoolClient(this, "McpUserPoolClient", {
        userPool,
        userPoolClientName: `swng-mcp-${stage}`,
        generateSecret: true,
        oAuth: {
          flows: { authorizationCodeGrant: true },
          // The SAME two scope objects the resource server registers, so the app client cannot end
          // up allowed a scope that was never declared (F5 again): each renders as the resource
          // server's own identifier joined to the scope name, never a second typed string.
          scopes: [OAuthScope.resourceServer(mcpResourceServer, readScope), OAuthScope.resourceServer(mcpResourceServer, writeScope)],
          // Cognito matches a callback EXACTLY. This is the same MCP_CALLBACK_PATH the route
          // table above declares — one constant, both halves, because the path Cognito redirects
          // to and the path this API routes have to be the same string or the browser leg dies
          // at a gateway 404 with the golfer already signed in.
          callbackUrls: [`https://${mcp.domainName}${MCP_CALLBACK_PATH}`],
          // No `logoutUrls` at all — omitted, not an empty array, so CDK renders no LogoutURLs
          // property whatsoever. The mediated flow has no logout leg (spec §4.3's four steps): a
          // golfer ends an MCP grant by disconnecting the connector, never by being redirected
          // through Cognito's /logout, so there is no URL to register and nothing for Cognito to
          // validate on the first deploy.
        },
      });

      // Spec §6, measured F6: a managed-login-v2 pool renders "Login pages unavailable. Please
      // contact an administrator." — no form, no error code — for an app client with no branding
      // resource of its own. The web client's branding does NOT cover this client. Same settings
      // and assets as the web's: it is the same product, and the golfer signing in to authorize
      // an agent should see the same sign-in page they always see.
      new CfnManagedLoginBranding(this, "McpManagedLoginBranding", {
        userPoolId: userPool.userPoolId,
        clientId: mcpUserPoolClient.userPoolClientId,
        useCognitoProvidedValues: false,
        settings: managedLoginSettings,
        assets: managedLoginAssets,
      });

      // Cognito GENERATES the client secret; nothing may supply one. The L1's `ClientSecret`
      // attribute is how it leaves CloudFormation without a describe-the-client custom resource,
      // and SecretValue.resourceAttribute is the sanctioned way to carry an attribute into a
      // secret's value. The plaintext never appears in the template — the rendered SecretString
      // is a Fn::GetAtt — and, exactly like TOKEN_SECRET_ARN (Arc A Task 4), only the ARN rides
      // in the Lambda's environment; the function fetches the value itself at runtime under an
      // audited GetSecretValue grant.
      const cfnMcpUserPoolClient = mcpUserPoolClient.node.defaultChild as CfnUserPoolClient;
      // DECLARED, not inherited (fix round 1, Minor 3). With no `authFlows` prop CDK omits
      // ExplicitAuthFlows entirely and Cognito applies its own default set
      // (REFRESH_TOKEN/USER_SRP/CUSTOM) — not exploitable here (SRP on a confidential client needs
      // the secret, and a token minted outside the resource-bound managed-login flow carries no
      // `aud`, which the verifier rejects), but the refresh grant the whole mediation design rests
      // on should not rest on an implicit AWS default. ALLOW_REFRESH_TOKEN_AUTH alone: the
      // authorization-code flow is governed by AllowedOAuthFlows above, not by this list, so
      // nothing else belongs here. The L1 escape hatch, the same idiom used for the web client's
      // callback URLs below (the L2 has no way to express refresh-only).
      cfnMcpUserPoolClient.explicitAuthFlows = ["ALLOW_REFRESH_TOKEN_AUTH"];
      // Fix round 1, Minor 4: the same prod-only anti-enumeration knob the web client carries.
      // Beta passes nothing, so no property renders and beta stays byte-identical; without this
      // line, the day prod gets an `mcp` config its managed-login sign-in would enumerate users
      // while the web's would not. Conditional at the L1 for the same reason the L2 spread is
      // conditional next door.
      if (props.preventUserExistenceErrors) cfnMcpUserPoolClient.preventUserExistenceErrors = "ENABLED";
      const mcpClientSecret = new Secret(this, "McpClientSecret", {
        secretName: `swng-mcp-client-secret-${stage}`,
        secretStringValue: SecretValue.resourceAttribute(cfnMcpUserPoolClient.attrClientSecret),
      });

      // The MCP endpoint itself: the whole application behind one bearer-token gate. Built like
      // httpFn — same sharedEnv, same table env, same grants below — because it dispatches the
      // SAME routes through the SAME composition root; only the transport and the credential
      // differ. USER_POOL_CLIENT_ID is deliberately absent: that is the WEB client's id, used by
      // buildApp only to construct its own ID-token verifier, and this entry supplies its own
      // access-token AccountVerifier instead (entries/mcp.ts's createMcpVerifiers).
      const mcpFn = makeFunction("McpFunction", "mcp");
      mcpFn.addEnvironment("TABLE_CORE", coreTable.tableName);
      mcpFn.addEnvironment("TABLE_PROJECTIONS", projectionsTable.tableName);
      mcpFn.addEnvironment("TABLE_SNAPSHOTS", snapshotsTable.tableName);
      mcpFn.addEnvironment("USER_POOL_ID", userPool.userPoolId);
      mcpFn.addEnvironment("WS_ENDPOINT", webSocketStage.callbackUrl);
      mcpFn.addEnvironment("MCP_RESOURCE", canonical);
      mcpFn.addEnvironment("MCP_CLIENT_ID", mcpUserPoolClient.userPoolClientId);

      // The mediating authorization server. NOT built via makeFunction, and that is the point of
      // the two-Lambda split (spec §3.4): it builds no App, carries no composition root, and must
      // not be handed sharedEnv's TOKEN_SECRET_ARN/WS_ENDPOINT/table names it has no use for.
      // Claude allows 10 seconds for discovery, registration and the token endpoint, so this
      // function's cold start is a budget item — 1024MB (double the rest) buys CPU share for the
      // one thing it does at init: parse a small bundle and fetch one secret.
      const mcpAuthFn = new NodejsFunction(this, "McpAuthFunction", {
        entry: entryPath("mcpAuth"),
        handler: "handler",
        runtime: Runtime.NODEJS_20_X,
        environment: {
          MCP_RESOURCE: canonical,
          TABLE_MCP_OAUTH: oauthTable.tableName,
          // authorize.ts builds `${domain}/oauth2/authorize` and token.ts `${domain}/oauth2/token`
          // — baseUrl() already carries the scheme and no trailing slash.
          COGNITO_DOMAIN: userPoolDomain.baseUrl(),
          MCP_CLIENT_ID: mcpUserPoolClient.userPoolClientId,
          MCP_CLIENT_SECRET_ARN: mcpClientSecret.secretArn,
        },
        timeout: Duration.seconds(15),
        memorySize: 1024,
      });

      // --- The MCP API ---------------------------------------------------------------------
      //
      // Its own HttpApi, not a second set of routes on the existing one: it answers on its own
      // host (the canonical URI's), carries a permissive CORS policy the golfer-facing API must
      // never have, and its two functions are throttled and alarmed apart from the web's.
      const mcpHostedZone = HostedZone.fromHostedZoneAttributes(this, "McpZone", { hostedZoneId: mcp.hostedZoneId, zoneName: mcp.zoneName });
      const mcpCertificate = new Certificate(this, "McpCertificate", { domainName: mcp.domainName, validation: CertificateValidation.fromDns(mcpHostedZone) });
      const mcpDomainName = new DomainName(this, "McpDomainName", { domainName: mcp.domainName, certificate: mcpCertificate });

      const mcpApi = new HttpApi(this, "McpApi", {
        apiName: `swng-mcp-${stage}`,
        // Spec §7. Deliberately permissive, and NOT the web API's scoped list: the only credential
        // this endpoint accepts is a bearer token in a header — no cookie, no ambient authority —
        // so an Origin allow-list would admit a set that never calls this endpoint while 403-ing
        // the browser-hosted MCP clients this exists for. `allowHeaders: ["*"]` because the
        // protocol's own `Mcp-Param-*` family is DYNAMIC and cannot be enumerated; a preflight
        // that omits one fails the whole request before any of this runs.
        corsPreflight: {
          allowOrigins: ["*"],
          allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST],
          // `*` AND `authorization`, never `*` alone (fix round 1, Important 1). The Fetch
          // Standard defines `Authorization` as a CORS NON-WILDCARD request-header name — the
          // definition exists precisely to exclude it from the wildcard expansion — so a
          // preflight answering `Access-Control-Allow-Headers: *` does not authorize the one
          // header every authenticated MCP call carries. AWS's own documented example value for
          // this field is `authorization, *` for exactly this reason. The wildcard is still
          // load-bearing: the protocol's `Mcp-Param-*` family is dynamic and cannot be
          // enumerated. Shipping `*` alone deploys clean and then fails silently, in a browser,
          // for the one client class spec §7 exists to serve.
          allowHeaders: ["*", "authorization"],
          // A browser can't READ a response header it wasn't given: the 401's
          // `WWW-Authenticate: Bearer resource_metadata="…"` is the entire discovery entry point
          // (entries/mcp.ts), and without this a browser-hosted client sees a bare 401 and has
          // nowhere to go. Never `*` here: the fetch spec ignores a wildcard for a request with
          // credentials, and naming the one header that matters is the same discipline as the
          // route table above.
          exposeHeaders: ["WWW-Authenticate"],
          // Without this the browser re-preflights before nearly every tool call — an extra
          // round trip against the 10 s budget spec §3.4 gives the whole exchange, paid on every
          // call rather than once (re-review, Minor K). 600 s is the largest value EVERY engine
          // honours in full: it is WebKit's hard cap (maxPreflightCacheTimeout = 600s), while
          // Chromium caps at 7200 s and Firefox at 86400 s. With no header at all the default is
          // 5 s. (Corrected in re-review 2, Minor 6 — the first version of this comment had both
          // browsers wrong, naming Chromium's pre-v76 cap as though it were current.)
          maxAge: Duration.minutes(10),
        },
        defaultDomainMapping: { domainName: mcpDomainName },
      });

      const mcpIntegration = new HttpLambdaIntegration("McpIntegration", mcpFn);
      const mcpAuthIntegration = new HttpLambdaIntegration("McpAuthIntegration", mcpAuthFn);
      for (const route of MCP_ROUTES) {
        mcpApi.addRoutes({ path: route.path, methods: [route.method], integration: mcpIntegration });
      }
      for (const route of MCP_AUTH_ROUTES) {
        mcpApi.addRoutes({ path: route.path, methods: [route.method], integration: mcpAuthIntegration });
      }

      // The alias record. A only, no AAAA: an API Gateway regional custom domain is IPv4-only
      // unless its ipAddressType opts into dualstack, so an AAAA alias here would publish an
      // address family the endpoint does not answer on — the opposite of the web distribution
      // above, where CloudFront IS dual-stack and omitting AAAA is what would break IPv6 clients.
      new ARecord(this, "McpAliasA", {
        zone: mcpHostedZone,
        recordName: mcp.domainName,
        target: RecordTarget.fromAlias(new ApiGatewayv2DomainProperties(mcpDomainName.regionalDomainName, mcpDomainName.regionalHostedZoneId)),
      });

      // Same stage-wide abuse ceiling as the web API (the constants above), reached through the
      // same L1 escape hatch. NO per-route settings here: `routeSettings` names routes by KEY
      // rather than by reference, which is what wedged a deploy once already (the stage update
      // ran before the route existed and API Gateway 404'd the unknown key) — a stage-wide
      // default carries no such ordering edge, and every route on this API is anonymous-reachable
      // anyway, so there is no narrower set worth singling out.
      if (!mcpApi.defaultStage) {
        throw new Error("McpApi has no defaultStage — createDefaultStage must stay true for the throttle escape hatch below to apply");
      }
      (mcpApi.defaultStage.node.defaultChild as CfnStage).defaultRouteSettings = {
        throttlingRateLimit: STAGE_THROTTLE_RATE_LIMIT,
        throttlingBurstLimit: STAGE_THROTTLE_BURST_LIMIT,
      };

      // --- MCP grants ---------------------------------------------------------------------
      //
      // mcpFn's mirror httpFn's exactly (above): the same dispatcher, over the same stores, with
      // the same broadcast on a score write — a narrower set would 500 the first tool call that
      // reached a table it couldn't see.
      roundsTable.grantReadWriteData(mcpFn);
      coreTable.grantReadWriteData(mcpFn);
      connectionsTable.grantReadWriteData(mcpFn);
      snapshotsTable.grantReadWriteData(mcpFn);
      projectionsTable.grantReadWriteData(mcpFn);
      webSocketApi.grantManageConnections(mcpFn);
      tokenSecret.grantRead(mcpFn);
      // mcpAuth's two, and only these two: it reaches nothing else in this account. Read AND
      // write on the store — every handler puts, takes or rotates an item.
      oauthTable.grantReadWriteData(mcpAuthFn);
      mcpClientSecret.grantRead(mcpAuthFn);

      // --- MCP alarms ---------------------------------------------------------------------
      //
      // The same two the web API carries, on the API a golfer's agent actually talks to.
      pagedWithRecovery(
        new Alarm(this, "McpApi5xxAlarm", {
          alarmDescription: "MCP API: >= 10 5xx responses in 2 of the last 3 five-minute windows (sustained server errors)",
          metric: mcpApi.metricServerError({ period: FIVE_MINUTES, statistic: "Sum" }),
          threshold: 10,
          evaluationPeriods: 3,
          datapointsToAlarm: 2,
          comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: TreatMissingData.NOT_BREACHING,
        }),
      );
      pagedWithRecovery(
        new Alarm(this, "McpApiP95LatencyAlarm", {
          alarmDescription: "MCP API: p95 latency over 3000ms in 2 of the last 3 five-minute windows",
          metric: mcpApi.metricLatency({ period: FIVE_MINUTES, statistic: "p95" }),
          threshold: 3000,
          evaluationPeriods: 3,
          datapointsToAlarm: 2,
          comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: TreatMissingData.NOT_BREACHING,
        }),
      );

      // THE ONE ALARM THAT EXISTS BECAUSE OF AN APPLICATION DECISION, not a symmetry with the web
      // API. Every failure to fetch a client's metadata document — DNS, TLS, timeout, a refused
      // private address — answers ONE uniform 400 and logs at warn, deliberately: the response
      // must not become an oracle that tells a stranger what our network can reach. The cost is
      // that a total egress or resolver outage is byte-identical, to CloudWatch, to one client's
      // typo'd client_id: off the function-error metric, off console.error, paging nobody. So the
      // signal has to come from this side. The metric counts the ONE fixed message
      // packages/lambda/src/oauth/clients.ts gives every network-layer failure (its
      // CIMD_FETCH_FAILED constant — pinned to this literal by test/mcpCanonical.test.ts, since a
      // synth cannot import it).
      //
      // A LITERAL filter pattern, not a JSON one: Lambda's default text log format prefixes every
      // line with a timestamp and request id, so the event is not parseable JSON and `{ $.field =
      // … }` would silently match nothing. That also means there is no `$.field` to carry a Stage
      // DIMENSION, which is why the stage rides in the metric NAME here while every EMF metric in
      // this stack dimensions on it instead.
      const cimdFetchFailures = new MetricFilter(this, "McpCimdFetchFailureFilter", {
        logGroup: mcpAuthFn.logGroup,
        filterPattern: FilterPattern.literal('"client metadata document could not be fetched"'),
        metricNamespace: "swng",
        metricName: `McpCimdFetchFailures-${stage}`,
        metricValue: "1",
        // Emit a real 0 when nothing matched, so the alarm evaluates on data rather than on the
        // missing-data policy.
        defaultValue: 0,
      });
      pagedWithRecovery(
        new Alarm(this, "McpCimdFetchFailureAlarm", {
          alarmDescription:
            "MCP authorization server: client metadata documents are failing to fetch, repeatedly — every such failure answers one uniform 400 by design, so this alarm is the only signal that swng's egress or DNS resolution is broken rather than one client having typo'd its client_id",
          metric: cimdFetchFailures.metric({ period: FIVE_MINUTES, statistic: "Sum" }),
          // Sustained, not a single burst: one client fumbling its own client_id produces a
          // handful of failures in ONE window and stops. An egress outage keeps producing them
          // for as long as it lasts, which is what 2 of 3 windows separates out.
          threshold: 3,
          evaluationPeriods: 3,
          datapointsToAlarm: 2,
          comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: TreatMissingData.NOT_BREACHING,
        }),
      );

      // The one string a golfer types into their MCP client.
      new CfnOutput(this, "McpUrl", { value: canonical });
    }

    // --- Outputs ----------------------------------------------------------------------

    new CfnOutput(this, "HttpApiUrl", { value: `${httpApi.apiEndpoint}/` });
    new CfnOutput(this, "WsApiUrl", { value: webSocketStage.url });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "HostedUiDomain", { value: userPoolDomain.baseUrl() });
    // scripts/publishWeb.mjs reads these two to sync apps/web/dist and invalidate the cache.
    new CfnOutput(this, "WebBucketName", { value: webBucket.bucketName });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new CfnOutput(this, "WebUrl", { value: `https://${distribution.distributionDomainName}/` });
    // Task D-T1: only emitted when a custom domain is configured — the plain cloudfront.net
    // WebUrl above always exists regardless.
    if (webDomain) {
      new CfnOutput(this, "WebDomainUrl", { value: `https://${webDomain.domainName}/` });
    }
  }
}
