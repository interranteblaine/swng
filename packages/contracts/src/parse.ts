import { z } from "zod";

export class ContractError extends Error {
  constructor(
    readonly code: "invalid-request",
    readonly issues: string[],
  ) {
    super(code);
  }
}

// The one generic parse (conventions §3) — every command/response boundary funnels
// through this instead of each handler rolling its own validation/error-shaping.
export const parse = <S extends z.ZodType>(schema: S, input: unknown): z.infer<S> => {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
    throw new ContractError("invalid-request", issues);
  }
  return result.data;
};
