import { useEffect, useMemo } from "react";
import * as z from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { useNavigate, useSearchParams } from "react-router-dom";
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
import { TeePicker } from "@/components/TeePicker";
import { TEE_COLORS } from "@/components/teeBadges";
import {
  getLastPlayerName,
  setLastPlayerName,
  getLastTeeColor,
  setLastTeeColor,
} from "@/lib/playerPrefs";

const formSchema = z.object({
  playerName: z
    .string()
    .trim()
    .min(1, "Player name must be at least 1 character")
    .max(32, "Player name must be at most 32 characters"),
  teeColor: z.enum(TEE_COLORS),
});

export function JoinDetailsView() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const accessCode = searchParams.get("code") ?? "";

  useEffect(() => {
    if (!accessCode) {
      void navigate("/rounds/join", { replace: true });
    }
  }, [accessCode, navigate]);

  const joinRound = useJoinRound();
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      playerName: getLastPlayerName() || "",
      teeColor: getLastTeeColor() as z.infer<typeof formSchema>["teeColor"],
    },
  });

  const onSubmit = async (data: z.infer<typeof formSchema>) => {
    const { playerName, teeColor } = data;
    setLastPlayerName(playerName);
    setLastTeeColor(teeColor);
    try {
      await joinRound.mutateAsync({
        accessCode,
        playerName,
        color: teeColor,
      });
    } catch {
      // error surfaced via joinRound.error
    }
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

  if (!accessCode) return null;

  return (
    <>
      <IonHeader>
        <IonToolbar style={navyToolbarStyle}>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/rounds/join" color="light" />
          </IonButtons>
          <IonTitle>Your Details</IonTitle>
        </IonToolbar>
      </IonHeader>

      <IonContent>
        <form
          id="join-details-form"
          className="ion-padding"
          onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
        >
          <p className="text-sm text-gray-500 mb-4">
            Joining with code: <span className="font-mono font-semibold">{accessCode}</span>
          </p>

          <IonList>
            <Controller
              name="playerName"
              control={form.control}
              render={({ field, fieldState }) => (
                <IonItem>
                  <IonInput
                    label="Your name"
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
              render={({ field }) => (
                <IonItem>
                  <div className="w-full py-2">
                    <label className="block text-sm font-medium mb-2">Tee</label>
                    <TeePicker value={field.value} onChange={field.onChange} />
                  </div>
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
              expand="block"
              type="submit"
              style={{ "--background": "#3d5a80" }}
              disabled={joinRound.isPending}
              className="flex-1"
            >
              {joinRound.isPending ? "Joining\u2026" : "Join round"}
            </IonButton>
          </div>
        </form>
      </IonContent>
    </>
  );
}
