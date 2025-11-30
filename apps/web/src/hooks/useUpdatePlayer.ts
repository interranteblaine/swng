import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RoundSnapshot, PlayerUpdatedEvent } from "@swng/domain";
import { client } from "../lib/client";
import { getSessionId } from "../lib/session";
import { reduceEvent } from "../lib/eventsReducer";

type Args = {
  playerId: string;
  name?: string;
  color?: string;
};

export function useUpdatePlayer(roundId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["updatePlayer", roundId],
    mutationFn: async ({ playerId, name, color }: Args) => {
      const sessionId = getSessionId(roundId);
      if (!sessionId) throw new Error("NO_SESSION");
      return client.updatePlayer({ roundId, sessionId, playerId, name, color });
    },
    onMutate: async ({ playerId, name, color }) => {
      await queryClient.cancelQueries({ queryKey: ["round", roundId] });

      const previous = queryClient.getQueryData<RoundSnapshot>([
        "round",
        roundId,
      ]);

      queryClient.setQueryData<RoundSnapshot | undefined>(
        ["round", roundId],
        (old) => {
          if (!old) return old;

          const existing = old.players.find((p) => p.playerId === playerId);
          if (!existing) return old;

          const nowIso = new Date().toISOString();

          const optimisticEvt: PlayerUpdatedEvent = {
            type: "PlayerUpdated",
            roundId,
            occurredAt: nowIso,
            player: {
              ...existing,
              ...(name !== undefined && { name }),
              ...(color !== undefined && { color }),
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
