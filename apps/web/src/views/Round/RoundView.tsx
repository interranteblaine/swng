import { useParams } from "react-router-dom";
import { RoundProvider } from "./Context/RoundProvider";
import { ScoreEntryPage } from "./ScoreEntry/ScoreEntryPage";

export function RoundView() {
  const { roundId } = useParams<{ roundId: string }>();

  if (!roundId) {
    return (
      <div role="alert" aria-live="assertive">
        Missing roundId in route.
      </div>
    );
  }

  return (
    <RoundProvider roundId={roundId}>
      <ScoreEntryPage />
    </RoundProvider>
  );
}
