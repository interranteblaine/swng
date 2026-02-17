import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RoundSnapshot, ScoreChangedEvent } from "@swng/domain";
import { client } from "../lib/client";
import { getSessionId, getSelfPlayerId } from "../lib/session";
import { reduceEvent } from "../lib/eventsReducer";

type Args = {
  playerId: string;
  holeNumber: number;
  strokes: number;
};

const DEBOUNCE_MS = 300;

function scoreKey(playerId: string, holeNumber: number) {
  return `${playerId}:${holeNumber}`;
}

export function useUpdateScore(roundId: string) {
  const queryClient = useQueryClient();

  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );
  const pendingRef = useRef<Map<string, Args>>(new Map());
  const rollbackRef = useRef<Map<string, RoundSnapshot>>(new Map());

  useEffect(() => {
    const timers = timersRef.current;
    const pending = pendingRef.current;
    const rollbacks = rollbackRef.current;
    return () => {
      for (const id of timers.values()) clearTimeout(id);
      timers.clear();
      pending.clear();
      rollbacks.clear();
    };
  }, []);

  const sendUpdate = useCallback(
    async (key: string) => {
      const args = pendingRef.current.get(key);
      if (!args) return;
      pendingRef.current.delete(key);

      try {
        const sessionId = getSessionId(roundId);
        if (!sessionId) throw new Error("NO_SESSION");
        await client.updateScore({
          roundId,
          sessionId,
          playerId: args.playerId,
          holeNumber: args.holeNumber,
          strokes: args.strokes,
        });
      } catch (err) {
        // Rollback to pre-burst snapshot on error
        const snap = rollbackRef.current.get(key);
        if (snap) {
          queryClient.setQueryData(["round", roundId], snap);
        }
        console.error("Score update failed, rolled back", err);
      } finally {
        rollbackRef.current.delete(key);
        timersRef.current.delete(key);
      }
    },
    [roundId, queryClient]
  );

  const mutate = useCallback(
    (args: Args) => {
      const key = scoreKey(args.playerId, args.holeNumber);

      // Capture rollback snapshot before the first click in a burst
      if (!rollbackRef.current.has(key)) {
        const current = queryClient.getQueryData<RoundSnapshot>([
          "round",
          roundId,
        ]);
        if (current) rollbackRef.current.set(key, current);
      }

      // Apply optimistic update immediately
      queryClient.setQueryData<RoundSnapshot | undefined>(
        ["round", roundId],
        (old) => {
          if (!old) return old;

          const nowIso = new Date().toISOString();
          const author = getSelfPlayerId(roundId) ?? args.playerId;

          const optimisticEvt: ScoreChangedEvent = {
            type: "ScoreChanged",
            roundId,
            occurredAt: nowIso,
            score: {
              roundId,
              playerId: args.playerId,
              holeNumber: args.holeNumber,
              strokes: args.strokes,
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

      // Store latest args and reset debounce timer
      pendingRef.current.set(key, args);

      const existing = timersRef.current.get(key);
      if (existing) clearTimeout(existing);

      timersRef.current.set(
        key,
        setTimeout(() => void sendUpdate(key), DEBOUNCE_MS)
      );
    },
    [roundId, queryClient, sendUpdate]
  );

  return { mutate };
}
