import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { RoundSnapshot } from "@swng/domain";
import { client } from "../lib/client";
import { setSessionId, setSelfPlayerId } from "../lib/session";

type CreateArgs = {
  courseName: string;
  par: number[];
  playerName: string;
  color?: string;
};

export function useCreateRound() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["createRound"],
    mutationFn: async (args: CreateArgs) => {
      const { courseName, par, playerName, color } = args;

      const created = await client.createRound({ courseName, par });

      const accessCode = created.config.accessCode;
      const joined = await client.joinRound({ accessCode, playerName, color });

      const { roundId, sessionId, player, snapshot } = joined;

      setSessionId(roundId, sessionId);
      setSelfPlayerId(roundId, player.playerId);
      queryClient.setQueryData<RoundSnapshot>(["round", roundId], snapshot);

      await navigate(`/rounds/${roundId}`);

      return { roundId, sessionId, snapshot };
    },
  });
}
