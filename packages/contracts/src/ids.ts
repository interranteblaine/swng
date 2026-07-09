import { z } from "zod";
import { courseId, deviceId, gameId, golferId, opId, roundId } from "@swng/domain";
import type { CourseId, DeviceId, GameId, GolferId, Hlc, OpId, RoundId } from "@swng/domain";

// Branded-at-parse id schemas: the wire carries plain strings, brands are applied the
// instant they cross into typed territory so nothing downstream re-validates them.
export const golferIdSchema: z.ZodType<GolferId> = z.string().min(1).transform(golferId);
export const roundIdSchema: z.ZodType<RoundId> = z.string().min(1).transform(roundId);
export const gameIdSchema: z.ZodType<GameId> = z.string().min(1).transform(gameId);
export const opIdSchema: z.ZodType<OpId> = z.string().min(1).transform(opId);
export const deviceIdSchema: z.ZodType<DeviceId> = z.string().min(1).transform(deviceId);
// Mirrors RoundId's brand-at-parse shape (M6): courses are their own CRUD aggregate, not
// event-sourced, but the id still crosses the wire as a plain string like every other id.
export const courseIdSchema: z.ZodType<CourseId> = z.string().min(1).transform(courseId);

export const hlcSchema: z.ZodType<Hlc> = z.object({
  wallMs: z.number().int().min(0),
  counter: z.number().int().min(0),
  deviceId: deviceIdSchema,
});
