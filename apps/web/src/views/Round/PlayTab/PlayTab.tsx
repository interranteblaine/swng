import { useState } from "react";
import { PlayHeader } from "./PlayHeader";
import { PlayPlayerList } from "./PlayPlayerList";
import { useRoundData, useRoundActions } from "../Context/useRoundContext";

export function PlayTab() {
  const { snapshot } = useRoundData();
  const { updateScore } = useRoundActions();
  const [visibleHole, setVisibleHole] = useState(1);

  const par = snapshot?.config.par ?? [];
  const holeCount = par.length;

  const players = (snapshot?.players ?? []).map((p) => ({
    playerId: p.playerId,
    name: p.name,
    color: (p as { color?: string | null }).color ?? undefined,
  }));

  const strokesByPlayer = (snapshot?.scores ?? [])
    .filter((s) => s.holeNumber === visibleHole)
    .reduce<Record<string, number | undefined>>((acc, s) => {
      acc[s.playerId] = s.strokes;
      return acc;
    }, {});

  return (
    <section id="panel-play" role="tabpanel" aria-labelledby="tab-play">
      <PlayHeader
        visibleHole={visibleHole}
        par={par}
        onPrevHole={() => setVisibleHole((h) => Math.max(1, h - 1))}
        onNextHole={() => setVisibleHole((h) => Math.min(holeCount, h + 1))}
      />
      <PlayPlayerList
        players={players}
        visibleHole={visibleHole}
        strokesByPlayer={strokesByPlayer}
        onChangeStrokes={(playerId, strokes) => {
          if (typeof strokes === "number") {
            updateScore({ playerId, holeNumber: visibleHole, strokes });
          }
        }}
      />
    </section>
  );
}
