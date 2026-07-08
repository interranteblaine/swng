import { z } from "zod";
import { roundIdSchema } from "./ids.js";
import { roundEventSchema } from "./round.js";

// The server→client envelope. One message type in v1: a batch of seq-stamped events
// for a round, pushed to every connection subscribed to that round's channel.
export const wsEnvelopeSchema = z.object({
  type: z.literal("events"),
  roundId: roundIdSchema,
  events: z.array(roundEventSchema).readonly(),
});

export type WsEnvelope = z.infer<typeof wsEnvelopeSchema>;
