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
  IonNote,
} from "@ionic/react";
import { useJoinRound } from "@/hooks/useJoinRound";
import { navyToolbarStyle } from "@/components/theme";

const formSchema = z.object({
  accessCode: z
    .string()
    .trim()
    .min(4, "Code must be at least 4 characters")
    .max(12, "Code must be at most 12 characters"),
  playerName: z
    .string()
    .trim()
    .min(1, "Player name must be at least 1 character")
    .max(32, "Player name must be at most 32 characters"),
  teeColor: z.union([
    z.literal(""),
    z.string().trim().max(12, "Tee color must be at most 12 characters"),
  ]),
});

export function JoinRoundView() {
  const joinRound = useJoinRound();
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      accessCode: "",
      playerName: "",
      teeColor: "",
    },
  });

  const onSubmit = async (data: z.infer<typeof formSchema>) => {
    const { accessCode, playerName, teeColor } = data;
    const color = teeColor.trim() === "" ? undefined : teeColor.trim();
    try {
      await joinRound.mutateAsync({
        accessCode,
        playerName,
        color,
      });
    } catch {
      // error is surfaced via joinRound.error; avoid unhandled promise rejection
    }
  };

  const onReset = () => {
    joinRound.reset();
    form.reset();
  };

  const errorMessage = useMemo(() => {
    const error = joinRound.error;

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
  }, [joinRound.error]);

  return (
    <>
      <IonHeader>
        <IonToolbar style={navyToolbarStyle}>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/" color="light" />
          </IonButtons>
          <IonTitle>Join Round</IonTitle>
        </IonToolbar>
      </IonHeader>

      <IonContent>
        <form
          id="join-round-form"
          className="ion-padding"
          onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
        >
          <IonList>
            <Controller
              name="accessCode"
              control={form.control}
              render={({ field, fieldState }) => (
                <IonItem>
                  <IonInput
                    label="Access code"
                    labelPlacement="stacked"
                    placeholder="XYSHSFL"
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
              disabled={joinRound.isPending}
            >
              {joinRound.isPending ? "Joining\u2026" : "Join round"}
            </IonButton>
          </div>
        </form>
      </IonContent>
    </>
  );
}
