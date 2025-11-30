import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RoundSnapshot, ScoreChangedEvent } from "@swng/domain";
import { client } from "../lib/client";
import { getSessionId, getSelfPlayerId } from "../lib/session";
import { reduceEvent } from "../lib/eventsReducer";

type Args = {
  playerId: string;
  holeNumber: number;
  strokes: number;
};

export function useUpdateScore(roundId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["updateScore", roundId],
    mutationFn: async ({ playerId, holeNumber, strokes }: Args) => {
      const sessionId = getSessionId(roundId);
      if (!sessionId) throw new Error("NO_SESSION");
      return client.updateScore({
        roundId,
        sessionId,
        playerId,
        holeNumber,
        strokes,
      });
    },
    onMutate: async ({ playerId, holeNumber, strokes }) => {
      await queryClient.cancelQueries({ queryKey: ["round", roundId] });

      const previous = queryClient.getQueryData<RoundSnapshot>([
        "round",
        roundId,
      ]);

      queryClient.setQueryData<RoundSnapshot | undefined>(
        ["round", roundId],
        (old) => {
          if (!old) return old;

          const nowIso = new Date().toISOString();
          const author = getSelfPlayerId(roundId) ?? playerId;

          const optimisticEvt: ScoreChangedEvent = {
            type: "ScoreChanged",
            roundId,
            occurredAt: nowIso,
            score: {
              roundId,
              playerId,
              holeNumber,
              strokes,
              updatedBy: author,
              updatedAt: nowIso,
            },
          };

          const updated = reduceEvent(old, optimisticEvt);
          if (!updated) {
            console.warn("Failed to apply optimistic update", optimisticEvt);
            return old;
          }

          return updated;
        }
      );

      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(["round", roundId], ctx.previous);
      }
    },
  });
}
