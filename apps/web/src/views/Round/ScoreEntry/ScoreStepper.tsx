import { IonButton, IonIcon } from "@ionic/react";
import { add, remove } from "ionicons/icons";

type ScoreStepperProps = {
  value: number | undefined;
  onChange: (value: number) => void;
};

const MIN = 1;
const MAX = 12;

export function ScoreStepper({ value, onChange }: ScoreStepperProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <IonButton
        fill="clear"
        size="small"
        disabled={value === undefined || value <= MIN}
        onClick={() => {
          if (value !== undefined && value > MIN) {
            onChange(value - 1);
          }
        }}
        aria-label="Decrease score"
      >
        <IonIcon slot="icon-only" icon={remove} />
      </IonButton>

      <span
        style={{
          minWidth: 28,
          textAlign: "center",
          fontSize: "1.125rem",
          fontWeight: 600,
        }}
      >
        {value ?? "-"}
      </span>

      <IonButton
        fill="clear"
        size="small"
        disabled={value !== undefined && value >= MAX}
        onClick={() => {
          if (value === undefined) {
            onChange(1);
          } else if (value < MAX) {
            onChange(value + 1);
          }
        }}
        aria-label="Increase score"
      >
        <IonIcon slot="icon-only" icon={add} />
      </IonButton>
    </div>
  );
}
