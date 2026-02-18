import { IonSegment, IonSegmentButton, IonLabel } from "@ionic/react";
import type { TeeSet } from "@swng/domain";

type TeePickerProps = {
  value: string;
  onChange: (value: string) => void;
  teeSets: TeeSet[];
};

export function TeePicker({ value, onChange, teeSets }: TeePickerProps) {
  return (
    <IonSegment
      value={value}
      onIonChange={(e) => {
        const val = e.detail.value;
        if (typeof val === "string") onChange(val);
      }}
    >
      {teeSets.map((ts) => (
        <IonSegmentButton key={ts.name} value={ts.name}>
          <IonLabel className="flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-3 rounded-full border border-gray-400"
              style={{ backgroundColor: ts.color }}
            />
            {ts.name}
          </IonLabel>
        </IonSegmentButton>
      ))}
    </IonSegment>
  );
}
