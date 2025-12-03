import { useContext } from "react";
import {
  RoundActionsContext,
  RoundDataContext,
  type RoundActions,
  type RoundData,
} from "./RoundContexts";

export function useRoundData(): RoundData {
  const ctx = useContext(RoundDataContext);
  if (!ctx) {
    throw new Error("useRoundData must be used within a RoundProvider");
  }
  return ctx;
}

export function useRoundActions(): RoundActions {
  const ctx = useContext(RoundActionsContext);
  if (!ctx) {
    throw new Error("useRoundActions must be used within a RoundProvider");
  }
  return ctx;
}
