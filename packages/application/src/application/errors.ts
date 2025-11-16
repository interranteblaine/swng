export type ApplicationErrorCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "INVALID_INPUT"
  | "INVARIANT_VIOLATION";

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode, message: string) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
  }
}
