import { z } from "zod";
import type { ParseOk, ParseErr, ValidationIssue } from "./rounds";

const TeeHoleSchema = z.object({
  holeNumber: z.number().int().min(1).max(18),
  par: z.union([z.literal(3), z.literal(4), z.literal(5)]),
  yardage: z.number().int().positive(),
  handicapIndex: z.number().int().min(1).max(18),
});

const TeeSetSchema = z.object({
  name: z.string().min(1).max(32),
  color: z.string().min(1),
  courseRating: z.number().min(50).max(90),
  slopeRating: z.number().int().min(55).max(155),
  holes: z.array(TeeHoleSchema).min(1),
});

export const CreateCourseRequest = z.object({
  name: z.string().min(1).max(64),
  location: z.string().max(128).optional(),
  holeCount: z.union([z.literal(9), z.literal(18)]),
  teeSets: z.array(TeeSetSchema).min(1),
});
export type CreateCourseRequest = z.infer<typeof CreateCourseRequest>;

function formatIssues(issues: ValidationIssue[]): string {
  const msg = issues
    .map((i) => {
      const p = i.path && i.path.length ? i.path.join(".") : "(root)";
      return `${p}: ${i.message}`;
    })
    .join("; ");
  return msg || "Invalid request";
}

export function parseCreateCourseRequest(
  input: unknown
): ParseOk<CreateCourseRequest> | ParseErr {
  const res = CreateCourseRequest.safeParse(input);
  if (res.success) return { ok: true, data: res.data };
  const issues: ValidationIssue[] = res.error.issues.map((i) => ({
    path: i.path as (string | number)[],
    message: i.message,
  }));
  return { ok: false, error: formatIssues(issues), issues };
}
