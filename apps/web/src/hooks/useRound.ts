import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RoundSnapshot, DomainEvent } from "@swng/domain";
import { reduceEvent } from "../lib/eventsReducer";
import { client } from "../lib/client";
import { getSessionId } from "../lib/session";

export function useRound(roundId: string) {
  const queryClient = useQueryClient();
  const sessionId = getSessionId(roundId);

  const query = useQuery<RoundSnapshot>({
    queryKey: ["round", roundId],
    enabled: !!sessionId,
    queryFn: async () => {
      if (!sessionId) {
        // Prevent fetch; enabled: false handles this, but keep type safety
        throw new Error("NO_SESSION");
      }
      const res = await client.getRound({ roundId, sessionId });
      return res.snapshot;
    },
  });

  useEffect(() => {
    if (!sessionId) return;

    const onEvent = (evt: DomainEvent) => {
      queryClient.setQueryData<RoundSnapshot | undefined>(
        ["round", roundId],
        (prev) => reduceEvent(prev, evt)
      );
    };

    const ws = client.connectEvents(sessionId, onEvent);

    return () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
  }, [sessionId, roundId, queryClient]);

  return {
    snapshot: query.data,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
