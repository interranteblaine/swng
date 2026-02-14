import { IonList, IonItem, IonLabel, IonBadge } from "@ionic/react";
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

export function ScoreEntryList({
  players,
  strokesByPlayer,
  onChangeStrokes,
}: ScoreEntryListProps) {
  return (
    <IonList>
      {players.map((p) => (
        <IonItem key={p.playerId}>
          <IonLabel>
            <h2>{p.name}</h2>
            <p>
              <IonBadge color="medium" style={{ marginRight: 4 }}>
                {p.color ?? "—"}
              </IonBadge>
              <span style={{ fontSize: "0.8rem", color: "var(--ion-color-medium)" }}>
                — yds
              </span>
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
