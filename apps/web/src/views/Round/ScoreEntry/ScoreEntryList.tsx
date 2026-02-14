import { IonList, IonItem, IonLabel } from "@ionic/react";
import { ScoreStepper } from "./ScoreStepper";

type PlayerView = {
  playerId: string;
  name: string;
  color?: string;
};

type ScoreEntryListProps = {
  players: PlayerView[];
  strokesByPlayer: Record<string, number | undefined>;
  onChangeStrokes: (playerId: string, strokes: number) => void;
};

const teeBadgeClasses: Record<string, string> = {
  Blue: "bg-blue-600 text-white",
  Red: "bg-red-600 text-white",
  White: "bg-white text-gray-800 border border-gray-300",
  Gold: "bg-amber-500 text-white",
};

export function ScoreEntryList({
  players,
  strokesByPlayer,
  onChangeStrokes,
}: ScoreEntryListProps) {
  return (
    <IonList>
      {players.map((p, i) => (
        <IonItem
          key={p.playerId}
          style={{ "--background": i % 2 === 1 ? "#f5f7fa" : "#ffffff" }}
        >
          <IonLabel>
            <h2 className="text-base font-semibold">{p.name}</h2>
            <p className="flex items-center gap-1.5">
              <span
                className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                  teeBadgeClasses[p.color ?? ""] ?? "bg-gray-500 text-white"
                }`}
              >
                {p.color ?? "—"}
              </span>
              <span className="text-xs text-gray-500">— yds</span>
            </p>
          </IonLabel>
          <div slot="end">
            <ScoreStepper
              value={strokesByPlayer[p.playerId]}
              onChange={(strokes) => onChangeStrokes(p.playerId, strokes)}
            />
          </div>
        </IonItem>
      ))}
    </IonList>
  );
}
