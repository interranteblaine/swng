import { useCallback, useMemo, type ReactNode } from "react";
import {
  IonPage,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButtons,
  IonBackButton,
  IonButton,
  IonSpinner,
} from "@ionic/react";
import { useRound } from "../../../hooks/useRound";
import { useUpdateScore } from "../../../hooks/useUpdateScore";
import { useUpdatePlayer } from "../../../hooks/useUpdatePlayer";
import { useRemovePlayer } from "../../../hooks/useRemovePlayer";
import { usePatchRoundState } from "../../../hooks/usePatchRoundState";
import { RoundActionsContext, RoundDataContext } from "./RoundContexts";
import { navyToolbarStyle } from "@/components/theme";
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

type RemovePlayerArgs = {
  playerId: string;
};

type PatchRoundStateArgs = {
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
  const removePlayerMutation = useRemovePlayer(roundId);
  const patchRoundStateMutation = usePatchRoundState(roundId);

  const updateScore = useCallback(
    (args: UpdateScoreArgs) => updateScoreMutation.mutate(args),
    [updateScoreMutation]
  );

  const updatePlayer = useCallback(
    (args: UpdatePlayerArgs) => updatePlayerMutation.mutate(args),
    [updatePlayerMutation]
  );

  const removePlayer = useCallback(
    (args: RemovePlayerArgs) => removePlayerMutation.mutate(args),
    [removePlayerMutation]
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
    () => ({ updateScore, updatePlayer, removePlayer, patchRoundState }),
    [updateScore, updatePlayer, removePlayer, patchRoundState]
  );

  if (isLoading) {
    if (loadingFallback) return <>{loadingFallback}</>;
    return (
      <IonPage>
        <IonHeader>
          <IonToolbar style={navyToolbarStyle}>
            <IonTitle>Loading...</IonTitle>
          </IonToolbar>
        </IonHeader>
        <IonContent>
          <div className="flex items-center justify-center h-full" aria-busy="true">
            <IonSpinner />
          </div>
        </IonContent>
      </IonPage>
    );
  }

  if (error) {
    if (errorFallback) return <>{errorFallback(error)}</>;
    const msg =
      (error as { message?: string })?.message ??
      (typeof error === "string" ? error : "Failed to load round.");
    return (
      <IonPage>
        <IonHeader>
          <IonToolbar style={navyToolbarStyle}>
            <IonButtons slot="start">
              <IonBackButton defaultHref="/" color="light" />
            </IonButtons>
            <IonTitle>Error</IonTitle>
          </IonToolbar>
        </IonHeader>
        <IonContent>
          <div className="flex flex-col items-center justify-center gap-4 p-6" role="alert" aria-live="assertive">
            <p className="text-red-600">{msg}</p>
            <IonButton
              style={{ "--background": "#3d5a80" }}
              onClick={() => void refetch()}
            >
              Try again
            </IonButton>
          </div>
        </IonContent>
      </IonPage>
    );
  }

  if (!snapshot) {
    return (
      <IonPage>
        <IonHeader>
          <IonToolbar style={navyToolbarStyle}>
            <IonButtons slot="start">
              <IonBackButton defaultHref="/" color="light" />
            </IonButtons>
            <IonTitle>Round</IonTitle>
          </IonToolbar>
        </IonHeader>
        <IonContent>
          <div className="flex items-center justify-center p-6" role="status">
            No round data available.
          </div>
        </IonContent>
      </IonPage>
    );
  }

  return (
    <RoundActionsContext.Provider value={actionsValue}>
      <RoundDataContext.Provider value={dataValue}>
        {children}
      </RoundDataContext.Provider>
    </RoundActionsContext.Provider>
  );
}
