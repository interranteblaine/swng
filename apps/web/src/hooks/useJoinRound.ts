import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { RoundSnapshot } from "@swng/domain";
import { client } from "../lib/client";
import {
  setSessionId,
  setSelfPlayerId,
  setCurrentRoundId,
} from "../lib/session";

type JoinArgs = {
  accessCode: string;
  playerName: string;
  color?: string;
};

export function useJoinRound() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["joinRound"],
    mutationFn: async (args: JoinArgs) => {
      const joined = await client.joinRound(args);

      const { snapshot, roundId, player, sessionId } = joined;

      setSessionId(roundId, sessionId);
      setSelfPlayerId(roundId, player.playerId);
      setCurrentRoundId(roundId);
      queryClient.setQueryData<RoundSnapshot>(["round", roundId], snapshot);

      await navigate(`/rounds/${roundId}`);

      return { roundId, sessionId, snapshot };
    },
  });
}
