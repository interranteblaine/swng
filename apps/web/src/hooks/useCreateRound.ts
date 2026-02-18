import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { RoundSnapshot } from "@swng/domain";
import { client } from "../lib/client";
import {
  setSessionId,
  setSelfPlayerId,
  setCurrentRoundId,
} from "../lib/session";

type CreateArgs = {
  courseId: string;
  playerName: string;
};

export function useCreateRound() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["createRound"],
    mutationFn: async (args: CreateArgs) => {
      const { courseId, playerName } = args;

      const { roundId, sessionId, player, snapshot } = await client.createRound({
        courseId,
        playerName,
      });

      setSessionId(roundId, sessionId);
      setSelfPlayerId(roundId, player.playerId);
      setCurrentRoundId(roundId);
      queryClient.setQueryData<RoundSnapshot>(["round", roundId], snapshot);

      await navigate(`/rounds/${roundId}`);

      return { roundId, sessionId, snapshot };
    },
  });
}
