import { IonSegment, IonSegmentButton, IonLabel } from "@ionic/react";
import { TEE_COLORS, type TeeColor } from "./teeBadges";

type TeePickerProps = {
  value: string;
  onChange: (value: string) => void;
};

const dotClasses: Record<TeeColor, string> = {
  Blue: "bg-blue-600",
  White: "bg-white border border-gray-400",
  Red: "bg-red-600",
  Gold: "bg-amber-500",
};

export function TeePicker({ value, onChange }: TeePickerProps) {
  return (
    <IonSegment
      value={value}
      onIonChange={(e) => {
        const val = e.detail.value;
        if (typeof val === "string") onChange(val);
      }}
    >
      {TEE_COLORS.map((color) => (
        <IonSegmentButton key={color} value={color}>
          <IonLabel className="flex items-center gap-1.5">
            <span
              className={`inline-block h-3 w-3 rounded-full ${dotClasses[color]}`}
            />
            {color}
          </IonLabel>
        </IonSegmentButton>
      ))}
    </IonSegment>
  );
}
