import { IonIcon } from "@ionic/react";
import { add, remove } from "ionicons/icons";

type ScoreStepperProps = {
  value: number | undefined;
  onChange: (value: number) => void;
};

const MIN = 1;
const MAX = 12;

export function ScoreStepper({ value, onChange }: ScoreStepperProps) {
  return (
    <div className="flex items-center">
      <button
        className="flex h-12 w-12 items-center justify-center rounded-l-lg border border-gray-300 bg-white text-gray-700 active:bg-gray-100 disabled:opacity-40"
        disabled={value === undefined || value <= MIN}
        onClick={() => {
          if (value !== undefined && value > MIN) {
            onChange(value - 1);
          }
        }}
        aria-label="Decrease score"
      >
        <IonIcon icon={remove} className="text-xl" />
      </button>

      <span className="flex h-12 w-14 items-center justify-center border-y border-gray-300 bg-white text-2xl font-bold text-gray-900">
        {value ?? "-"}
      </span>

      <button
        className="flex h-12 w-12 items-center justify-center rounded-r-lg border border-gray-300 bg-white text-gray-700 active:bg-gray-100 disabled:opacity-40"
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
        <IonIcon icon={add} className="text-xl" />
      </button>
    </div>
  );
}
