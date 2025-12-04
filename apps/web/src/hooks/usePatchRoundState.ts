import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  RoundSnapshot,
  RoundStateChangedEvent,
  RoundStatus,
} from "@swng/domain";
import { client } from "../lib/client";
import { getSessionId } from "../lib/session";
import { reduceEvent } from "../lib/eventsReducer";

type Args = {
  status?: RoundStatus | null;
};

export function usePatchRoundState(roundId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["patchRoundState", roundId],
    mutationFn: async ({ status }: Args) => {
      const sessionId = getSessionId(roundId);
      if (!sessionId) throw new Error("NO_SESSION");
      return client.patchRoundState({
        roundId,
        sessionId,
        status,
      });
    },
    onMutate: async ({ status }) => {
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

          const nextState = {
            ...old.state,
            ...(status !== undefined && { status }),
            updatedAt: nowIso,
            // keep stateVersion as-is for optimistic update; server will correct via WS
          };

          const optimisticEvt: RoundStateChangedEvent = {
            type: "RoundStateChanged",
            roundId,
            occurredAt: nowIso,
            state: nextState,
          };

          const updated = reduceEvent(old, optimisticEvt);
          if (!updated) {
            console.warn(
              "Failed to apply optimistic state update",
              optimisticEvt
            );
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
