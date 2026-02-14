import { useMemo } from "react";
import * as z from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButtons,
  IonBackButton,
  IonButton,
  IonList,
  IonItem,
  IonInput,
  IonRadioGroup,
  IonRadio,
  IonNote,
} from "@ionic/react";
import { useCreateRound } from "@/hooks/useCreateRound";
import { navyToolbarStyle } from "@/components/theme";

const formSchema = z.object({
  courseName: z
    .string()
    .trim()
    .min(1, "Course must be at least 1 character")
    .max(32, "Course must be at most 32 characters"),
  playerName: z
    .string()
    .trim()
    .min(1, "Player name must be at least 1 character")
    .max(32, "Player name must be at most 32 characters"),
  teeColor: z.union([
    z.literal(""),
    z.string().trim().max(12, "Tee color must be at most 12 characters"),
  ]),
  holeCount: z.union(
    [z.literal(9), z.literal(18)],
    "Hole count must be either 9 or 18"
  ),
});

export function CreateRoundView() {
  const createRound = useCreateRound();
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      courseName: "",
      playerName: "",
      teeColor: "",
      holeCount: 18,
    },
  });

  const onSubmit = async (data: z.infer<typeof formSchema>) => {
    const { courseName, playerName, teeColor, holeCount } = data;
    const color = teeColor.trim() === "" ? undefined : teeColor.trim();
    const par = Array.from({ length: holeCount }, () => 4);
    try {
      await createRound.mutateAsync({
        courseName,
        par,
        playerName,
        color,
      });
    } catch {
      // error surface via createRound.error; prevent unhandled rejection
    }
  };

  const onReset = () => {
    createRound.reset();
    form.reset();
  };

  const errorMessage = useMemo(() => {
    const error = createRound.error;

    if (!error) return undefined;

    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === "object" && error !== null && "message" in error) {
      const msg = (error as { message: unknown }).message;
      if (typeof msg === "string") {
        return msg;
      }
    }

    if (typeof error === "string") {
      return error;
    }

    return "An unexpected error occurred";
  }, [createRound.error]);

  return (
    <>
      <IonHeader>
        <IonToolbar style={navyToolbarStyle}>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/" color="light" />
          </IonButtons>
          <IonTitle>Create Round</IonTitle>
        </IonToolbar>
      </IonHeader>

      <IonContent>
        <form
          id="create-round-form"
          className="ion-padding"
          onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
        >
          <IonList>
            <Controller
              name="courseName"
              control={form.control}
              render={({ field, fieldState }) => (
                <IonItem>
                  <IonInput
                    label="Course name"
                    labelPlacement="stacked"
                    placeholder="Pebble Beach"
                    value={field.value}
                    onIonInput={(e) => field.onChange(e.detail.value ?? "")}
                    onIonBlur={field.onBlur}
                    className={fieldState.invalid ? "ion-invalid ion-touched" : ""}
                  />
                  {fieldState.invalid && (
                    <IonNote slot="error" className="text-red-600 text-sm">
                      {fieldState.error?.message}
                    </IonNote>
                  )}
                </IonItem>
              )}
            />

            <Controller
              name="holeCount"
              control={form.control}
              render={({ field, fieldState }) => (
                <IonItem>
                  <div className="w-full py-2">
                    <label className="block text-sm font-medium mb-2">Holes</label>
                    <IonRadioGroup
                      value={field.value}
                      onIonChange={(e) => field.onChange(e.detail.value as number)}
                    >
                      <div className="flex gap-6">
                        <IonRadio value={18} labelPlacement="end">18</IonRadio>
                        <IonRadio value={9} labelPlacement="end">9</IonRadio>
                      </div>
                    </IonRadioGroup>
                    {fieldState.invalid && (
                      <IonNote className="text-red-600 text-sm">
                        {fieldState.error?.message}
                      </IonNote>
                    )}
                  </div>
                </IonItem>
              )}
            />

            <Controller
              name="playerName"
              control={form.control}
              render={({ field, fieldState }) => (
                <IonItem>
                  <IonInput
                    label="Player name"
                    labelPlacement="stacked"
                    placeholder="Your name"
                    value={field.value}
                    onIonInput={(e) => field.onChange(e.detail.value ?? "")}
                    onIonBlur={field.onBlur}
                    className={fieldState.invalid ? "ion-invalid ion-touched" : ""}
                  />
                  {fieldState.invalid && (
                    <IonNote slot="error" className="text-red-600 text-sm">
                      {fieldState.error?.message}
                    </IonNote>
                  )}
                </IonItem>
              )}
            />

            <Controller
              name="teeColor"
              control={form.control}
              render={({ field, fieldState }) => (
                <IonItem>
                  <IonInput
                    label="Tee color"
                    labelPlacement="stacked"
                    placeholder="White"
                    value={field.value}
                    onIonInput={(e) => field.onChange(e.detail.value ?? "")}
                    onIonBlur={field.onBlur}
                    className={fieldState.invalid ? "ion-invalid ion-touched" : ""}
                  />
                  {fieldState.invalid && (
                    <IonNote slot="error" className="text-red-600 text-sm">
                      {fieldState.error?.message}
                    </IonNote>
                  )}
                </IonItem>
              )}
            />
          </IonList>

          {errorMessage && (
            <p className="text-red-600 text-sm ion-padding-start" aria-live="assertive">
              {errorMessage}
            </p>
          )}

          <div className="flex gap-3 ion-padding-top">
            <IonButton
              fill="outline"
              style={{ "--color": "#3d5a80", "--border-color": "#3d5a80" }}
              onClick={onReset}
            >
              Reset
            </IonButton>
            <IonButton
              type="submit"
              style={{ "--background": "#3d5a80" }}
              disabled={createRound.isPending}
            >
              {createRound.isPending ? "Creating\u2026" : "Create round"}
            </IonButton>
          </div>
        </form>
      </IonContent>
    </>
  );
}
