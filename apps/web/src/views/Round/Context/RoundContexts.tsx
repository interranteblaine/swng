import { createContext } from "react";
import type { RoundSnapshot } from "@swng/domain";

export type RoundData = {
  snapshot: RoundSnapshot | undefined;
  isLoading: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
};

export type RoundActions = {
  updateScore: (args: {
    playerId: string;
    holeNumber: number;
    strokes: number;
  }) => void;
  updatePlayer: (args: {
    playerId: string;
    name?: string;
    color?: string;
  }) => void;
  removePlayer: (args: { playerId: string }) => void;
  patchRoundState: (args: {
    status?: RoundSnapshot["state"]["status"] | null;
  }) => void;
};

export const RoundDataContext = createContext<RoundData | undefined>(undefined);
export const RoundActionsContext = createContext<RoundActions | undefined>(
  undefined
);
