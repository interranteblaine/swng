import { useCallback, useMemo, type ReactNode } from "react";
import { useRound } from "../../../hooks/useRound";
import { useUpdateScore } from "../../../hooks/useUpdateScore";
import { useUpdatePlayer } from "../../../hooks/useUpdatePlayer";
import { usePatchRoundState } from "../../../hooks/usePatchRoundState";
import { RoundActionsContext, RoundDataContext } from "./RoundContexts";
import type { RoundSnapshot } from "@swng/domain";

type UpdateScoreArgs = {
  playerId: string;
  holeNumber: number;
  strokes: number;
};

type UpdatePlayerArgs = {
  playerId: string;
  name?: string;
  color?: string;
};

type PatchRoundStateArgs = {
  currentHole?: number;
  status?: RoundSnapshot["state"]["status"] | null;
};

type RoundProviderProps = {
  roundId: string;
  children: ReactNode;
  loadingFallback?: ReactNode;
  errorFallback?: (error: unknown) => ReactNode;
};

/**
 * RoundProvider
 * - Establishes a single useRound subscription (and websocket) for the subtree
 * - Exposes read-only round data via RoundDataContext
 * - Exposes pre-bound mutations via RoundActionsContext
 * - Gates children on loading / error to keep leaves simple
 */
export function RoundProvider({
  roundId,
  children,
  loadingFallback,
  errorFallback,
}: RoundProviderProps) {
  const { snapshot, isLoading, error, refetch } = useRound(roundId);

  const updateScoreMutation = useUpdateScore(roundId);
  const updatePlayerMutation = useUpdatePlayer(roundId);
  const patchRoundStateMutation = usePatchRoundState(roundId);

  const updateScore = useCallback(
    (args: UpdateScoreArgs) => updateScoreMutation.mutate(args),
    [updateScoreMutation]
  );

  const updatePlayer = useCallback(
    (args: UpdatePlayerArgs) => updatePlayerMutation.mutate(args),
    [updatePlayerMutation]
  );

  const patchRoundState = useCallback(
    (args: PatchRoundStateArgs) => patchRoundStateMutation.mutate(args),
    [patchRoundStateMutation]
  );

  const dataValue = useMemo(
    () => ({ snapshot, isLoading, error: (error as unknown) ?? null, refetch }),
    [snapshot, isLoading, error, refetch]
  );

  const actionsValue = useMemo(
    () => ({ updateScore, updatePlayer, patchRoundState }),
    [updateScore, updatePlayer, patchRoundState]
  );

  if (isLoading) {
    return <>{loadingFallback ?? <div aria-busy="true">Loading round…</div>}</>;
  }

  if (error) {
    if (errorFallback) return <>{errorFallback(error)}</>;
    const msg =
      (error as { message?: string })?.message ??
      (typeof error === "string" ? error : "Failed to load round.");
    return (
      <div role="alert" aria-live="assertive">
        {msg}
      </div>
    );
  }

  if (!snapshot) {
    return <div role="status">No round data available.</div>;
  }

  return (
    <RoundActionsContext.Provider value={actionsValue}>
      <RoundDataContext.Provider value={dataValue}>
        {children}
      </RoundDataContext.Provider>
    </RoundActionsContext.Provider>
  );
}
