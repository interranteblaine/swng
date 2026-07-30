// Type-only, and zod is a devDependency of this package because of it: nothing here imports zod at
// runtime (the schemas arrive from @swng/contracts), and neither exported signature below mentions
// a zod type, so the emitted .d.ts carries no zod reference either. A runtime `dependencies` entry
// would have claimed a coupling that doesn't exist.
import type { ZodType } from "zod";
import type { RoundArchive, RoundEvent } from "@swng/domain";
import { DomainError } from "@swng/domain";
import { roundArchiveSchema, roundEventSchema } from "@swng/contracts";

// The ONE place a stored DynamoDB attribute becomes a domain value (spec 2026-07-30 §10, "the
// stored-data cast is made honest"). The read paths here used to write
// `result.Items?.[0] as { event: RoundEvent }` — an assertion, not a check — so a field the
// domain type declares required could simply be absent at runtime and every consumer downstream
// believed the type. The client has always parsed every event it pulled; the server parsed
// nothing it read. That asymmetry is what this closes: one schema, one decision about what is
// readable, applied on both sides of the wire.
//
// The codes are exported because they ARE the contract with the error boundary — the lambda's
// errorMapping test pins their behaviour against these exact strings rather than inventing its
// own (its own M6 lesson: a mapping test that invents error strings proves nothing).

// Deliberately ABSENT from errorMapping.ts's DOMAIN_ERROR_STATUS table, both of them: a stored
// item that no longer matches its schema is a genuine bug, so it falls through to the generic 500
// with the full message logged. There is nothing a client could send differently to fix it.
export const STORED_EVENT_INVALID = "stored-event-invalid";
export const STORED_ARCHIVE_INVALID = "stored-archive-invalid";

// NOT `contracts`' own `parse` helper, deliberately: that throws
// `ContractError("invalid-request")`, which the lambda's error map turns into a 400 naming the
// offending fields. A corrupt stored item is not a bad request, and its field paths are internal
// detail — a `DomainError` with an unmapped code is opaque to the client and fully logged, which
// is the right split.
const parseStored = <T>(schema: ZodType<T>, code: string, context: string, input: unknown): T => {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  // Same issue-flattening as contracts' parse — the path is what makes a stored-shape failure
  // diagnosable at all ("participants.0.strokes: Invalid input"), and it is logged, never returned.
  //
  // The code is repeated INTO the message on purpose: `DomainError`'s own constructor falls back
  // to the code only when no message is given, so a message-carrying DomainError would otherwise
  // lose its name from every log line (errorMapping.ts logs `error.stack ?? error.message`, and a
  // stack reads `DomainError: <message>`). The one place this failure gets diagnosed is a log, so
  // the name has to be in it.
  const issues = result.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
  throw new DomainError(code, `${code} — ${context}: ${issues.join("; ")}`);
};

// `roundEventSchema` is the SAME schema the client parses its pulls with (client/src/transport.ts),
// so what the server tolerates (a stray M8-era `crewId` stripped, a legacy skins config defaulted
// to net) and what it refuses (a deleted `conceded` cell, a seat with no `strokes`) is one decision
// made in one place rather than two implementations that can drift.
export const parseStoredEvent = (context: string, input: unknown): RoundEvent => parseStored(roundEventSchema, STORED_EVENT_INVALID, context, input);

// A settled round is read back from storage through FOUR doors — createDynamoSnapshotStore's
// get / getMany / page (finalize's idempotent replay, crew standings, the rebuild backfill) and
// parseSnapshotStreamImage (the projector's stream record, which writes a golfer's permanent
// record). All four asserted `item.archive as RoundArchive`. One function so the answer to "is
// this archive readable?" cannot differ by door — a snapshot the projector refuses must not be
// one the standings quietly fold.
export const parseStoredArchive = (context: string, input: unknown): RoundArchive => parseStored(roundArchiveSchema, STORED_ARCHIVE_INVALID, context, input);
