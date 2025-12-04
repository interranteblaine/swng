import { z } from "zod";

export const RoundStatusDto = z.union([
  z.literal("IN_PROGRESS"),
  z.literal("COMPLETED"),
]);

export const CreateRoundRequest = z.object({
  courseName: z.string().min(1),
  par: z.array(z.number().int().positive()).min(1),
});
export type CreateRoundRequest = z.infer<typeof CreateRoundRequest>;

export const JoinRoundRequest = z.object({
  accessCode: z.string().min(1),
  playerName: z.string().min(1),
  color: z.string().min(1).optional(),
});
export type JoinRoundRequest = z.infer<typeof JoinRoundRequest>;

export const UpdateScoreRequest = z.object({
  playerId: z.string().min(1),
  holeNumber: z.number().int().positive(),
  strokes: z.number().int().positive(),
});
export type UpdateScoreRequest = z.infer<typeof UpdateScoreRequest>;

export const PatchRoundStateRequest = z.object({
  status: RoundStatusDto.nullable().optional(),
});
export type PatchRoundStateRequest = z.infer<typeof PatchRoundStateRequest>;

export const UpdatePlayerRequest = z.object({
  name: z.string().min(1).optional(),
  color: z.string().min(1).optional(),
});
export type UpdatePlayerRequest = z.infer<typeof UpdatePlayerRequest>;

/**
 * Public parser results that do not leak zod types.
 * Consumers get a simple ok/data or ok/error contract.
 */
export type ValidationIssue = { path: (string | number)[]; message: string };
export type ParseOk<T> = { ok: true; data: T };
export type ParseErr = { ok: false; error: string; issues: ValidationIssue[] };

function formatIssues(issues: ValidationIssue[]): string {
  const msg = issues
    .map((i) => {
      const p = i.path && i.path.length ? i.path.join(".") : "(root)";
      return `${p}: ${i.message}`;
    })
    .join("; ");
  return msg || "Invalid request";
}

export function parseCreateRoundRequest(
  input: unknown
): ParseOk<CreateRoundRequest> | ParseErr {
  const res = CreateRoundRequest.safeParse(input);
  if (res.success) return { ok: true, data: res.data };
  const issues: ValidationIssue[] = res.error.issues.map((i) => ({
    path: i.path as (string | number)[],
    message: i.message,
  }));
  return { ok: false, error: formatIssues(issues), issues };
}

export function parseJoinRoundRequest(
  input: unknown
): ParseOk<JoinRoundRequest> | ParseErr {
  const res = JoinRoundRequest.safeParse(input);
  if (res.success) return { ok: true, data: res.data };
  const issues: ValidationIssue[] = res.error.issues.map((i) => ({
    path: i.path as (string | number)[],
    message: i.message,
  }));
  return { ok: false, error: formatIssues(issues), issues };
}

export function parseUpdateScoreRequest(
  input: unknown
): ParseOk<UpdateScoreRequest> | ParseErr {
  const res = UpdateScoreRequest.safeParse(input);
  if (res.success) return { ok: true, data: res.data };
  const issues: ValidationIssue[] = res.error.issues.map((i) => ({
    path: i.path as (string | number)[],
    message: i.message,
  }));
  return { ok: false, error: formatIssues(issues), issues };
}

export function parsePatchRoundStateRequest(
  input: unknown
): ParseOk<PatchRoundStateRequest> | ParseErr {
  const res = PatchRoundStateRequest.safeParse(input);
  if (res.success) return { ok: true, data: res.data };
  const issues: ValidationIssue[] = res.error.issues.map((i) => ({
    path: i.path as (string | number)[],
    message: i.message,
  }));
  return { ok: false, error: formatIssues(issues), issues };
}

export function parseUpdatePlayerRequest(
  input: unknown
): ParseOk<UpdatePlayerRequest> | ParseErr {
  const res = UpdatePlayerRequest.safeParse(input);
  if (res.success) return { ok: true, data: res.data };
  const issues: ValidationIssue[] = res.error.issues.map((i) => ({
    path: i.path as (string | number)[],
    message: i.message,
  }));
  return { ok: false, error: formatIssues(issues), issues };
}
