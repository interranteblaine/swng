import type { Score } from "@swng/domain";

type Props = {
  scores: Score[];
};

export default function ScoresList({ scores }: Props) {
  if (!scores || scores.length === 0) {
    return <section>No scores yet</section>;
  }

  return (
    <section>
      <h3>Scores</h3>
      <ul>
        {scores.map((s) => (
          <li key={`${s.playerId}-${s.holeNumber}`}>
            player:{s.playerId} • hole:{s.holeNumber} • strokes:{s.strokes} •
            updatedBy:{s.updatedBy} • at:{s.updatedAt}
          </li>
        ))}
      </ul>
    </section>
  );
}
