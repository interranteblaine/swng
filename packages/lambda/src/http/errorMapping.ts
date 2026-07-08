import type { ApplicationErrorCode, Logger } from "@swng/application";
import { ApplicationError } from "@swng/application";
import { ContractError } from "@swng/contracts";
import { DomainError } from "@swng/domain";

// The ONE code -> HTTP status map (M3 plan, Global Constraints — "error mapping lives in
// ONE lambda module"). `unknown-golfer-in-game` isn't named in the plan's mapping sentence;
// it's a request that names a golfer outside the round, the same "referenced id isn't part
// of this context" shape as domain's `unknown-tee-set` (also 400) — bucketed alongside it
// rather than falling through to the generic 500 (flagged for final review).
const APPLICATION_ERROR_STATUS: Record<ApplicationErrorCode, number> = {
  "invalid-token": 401,
  "not-a-participant": 403,
  "token-round-mismatch": 403,
  "round-not-found": 404,
  "bad-join-code": 404,
  "round-not-live": 409,
  "round-final": 409,
  "unknown-golfer-in-game": 400,
};

// The only two DomainError codes this boundary is documented to see: `unknown-tee-set`
// (a command names a tee not on the card) and `game-unresolved` (finalize's settleRound
// over a game that never closed out). Any other DomainError reaching here is a genuine bug,
// not a client-shaped error, so it falls through to the generic 500 below.
const DOMAIN_ERROR_STATUS: Record<string, number> = {
  "unknown-tee-set": 400,
  "game-unresolved": 409,
};

const jsonResponse = (statusCode: number, body: { code: string; message: string }): { statusCode: number; body: string } => ({
  statusCode,
  body: JSON.stringify(body),
});

export const toHttpError = (error: unknown, logger: Logger): { statusCode: number; body: string } => {
  if (error instanceof ContractError) {
    return jsonResponse(400, { code: error.code, message: error.issues.join("; ") });
  }

  if (error instanceof ApplicationError) {
    return jsonResponse(APPLICATION_ERROR_STATUS[error.code], { code: error.code, message: error.message });
  }

  if (error instanceof DomainError) {
    const statusCode = DOMAIN_ERROR_STATUS[error.code];
    if (statusCode !== undefined) {
      return jsonResponse(statusCode, { code: error.code, message: error.message });
    }
  }

  // Unknown errors never leak internals to the client (M3 plan) — full detail goes to the
  // logger only.
  logger.error("dispatcher: unhandled error", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  return jsonResponse(500, { code: "internal-error", message: "an unexpected error occurred" });
};
