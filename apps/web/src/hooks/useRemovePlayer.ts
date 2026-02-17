import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RoundSnapshot } from "@swng/domain";
import { client } from "../lib/client";
import { getSessionId } from "../lib/session";

type Args = {
  playerId: string;
};

export function useRemovePlayer(roundId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["removePlayer", roundId],
    mutationFn: async ({ playerId }: Args) => {
      const sessionId = getSessionId(roundId);
      if (!sessionId) throw new Error("NO_SESSION");
      return await client.removePlayer({ roundId, sessionId, playerId });
    },
    onMutate: async ({ playerId }) => {
      await queryClient.cancelQueries({ queryKey: ["round", roundId] });

      const previous = queryClient.getQueryData<RoundSnapshot>([
        "round",
        roundId,
      ]);

      queryClient.setQueryData<RoundSnapshot | undefined>(
        ["round", roundId],
        (old) => {
          if (!old) return old;
          return {
            ...old,
            players: old.players.filter((p) => p.playerId !== playerId),
          };
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
