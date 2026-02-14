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
import { navyToolbarStyle } from "@/components/theme";

const formSchema = z.object({
  accessCode: z
    .string()
    .trim()
    .min(4, "Code must be at least 4 characters")
    .max(12, "Code must be at most 12 characters"),
});

export function JoinRoundView() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const codeFromUrl = searchParams.get("code") ?? "";

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      accessCode: codeFromUrl,
    },
  });

  const onSubmit = (data: z.infer<typeof formSchema>) => {
    const code = data.accessCode.trim();
    void navigate(`/rounds/join/details?code=${encodeURIComponent(code)}`);
  };

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
                    placeholder="Enter round code"
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

          <div className="flex gap-3 ion-padding-top">
            <IonButton
              expand="block"
              type="submit"
              style={{ "--background": "#3d5a80" }}
              className="flex-1"
            >
              Join
            </IonButton>
          </div>
        </form>
      </IonContent>
    </>
  );
}
