import { useMemo } from "react";
import { Navigate, useParams } from "react-router-dom";
import { getSessionId } from "../lib/session";
import { useRound } from "../hooks/useRound";
import RoundHeader from "../components/RoundHeader";
import PlayersList from "../components/PlayersList";
import ScoresList from "../components/ScoresList";
import UpdateScoreForm from "../components/UpdateScoreForm";
import UpdatePlayerForm from "../components/UpdatePlayerForm";
import RoundStateForm from "../components/RoundStateForm";

export default function RoundPage() {
  const { roundId: roundIdParam } = useParams<{ roundId: string }>();
  const roundId = roundIdParam ?? "";

  const { snapshot, isLoading, error } = useRound(roundId);

  const sessionId = useMemo(() => getSessionId(roundId), [roundId]);
  const players = useMemo(() => snapshot?.players ?? [], [snapshot]);
  const state = useMemo(() => snapshot?.state, [snapshot]);
  const scores = useMemo(() => snapshot?.scores ?? [], [snapshot]);

  if (!roundId) return <Navigate to="/" replace />;
  if (!sessionId) return <Navigate to="/rounds/join" replace />;

  if (isLoading) return <div>Loading round...</div>;
  if (error) {
    return (
      <div style={{ color: "tomato" }}>
        {error instanceof Error ? error.message : "Failed to load round"}
      </div>
    );
  }

  if (!snapshot || !state) return <div>No data</div>;

  return (
    <div style={{ textAlign: "left", display: "grid", gap: 16 }}>
      <RoundHeader snapshot={snapshot} />
      <PlayersList players={players} />
      <ScoresList scores={scores} />
      <UpdateScoreForm
        roundId={roundId}
        players={players}
        currentHole={state.currentHole}
      />
      <UpdatePlayerForm roundId={roundId} players={players} />
      <RoundStateForm roundId={roundId} state={state} />
    </div>
  );
}
