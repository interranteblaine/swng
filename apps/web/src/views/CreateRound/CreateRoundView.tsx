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
  IonSelect,
  IonSelectOption,
  IonSpinner,
} from "@ionic/react";
import { useCreateRound } from "@/hooks/useCreateRound";
import { useCourses } from "@/hooks/useCourses";
import { navyToolbarStyle } from "@/components/theme";
import { getLastPlayerName, setLastPlayerName } from "@/lib/playerPrefs";

const formSchema = z.object({
  courseId: z.string().trim().min(1, "Course is required"),
  playerName: z
    .string()
    .trim()
    .min(1, "Player name must be at least 1 character")
    .max(32, "Player name must be at most 32 characters"),
});

export function CreateRoundView() {
  const createRound = useCreateRound();
  const { courses, isLoading: coursesLoading } = useCourses();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      courseId: "",
      playerName: getLastPlayerName() || "",
    },
  });

  const onSubmit = async (data: z.infer<typeof formSchema>) => {
    const { courseId, playerName } = data;
    setLastPlayerName(playerName);
    try {
      await createRound.mutateAsync({ courseId, playerName });
    } catch {
      // error surface via createRound.error; prevent unhandled rejection
    }
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
              name="courseId"
              control={form.control}
              render={({ field, fieldState }) => (
                <IonItem>
                  {coursesLoading ? (
                    <div className="flex items-center gap-2 py-3">
                      <IonSpinner name="crescent" />
                      <span className="text-sm text-gray-500">Loading courses…</span>
                    </div>
                  ) : courses.length === 0 ? (
                    <div className="py-3">
                      <span className="text-sm text-gray-500">No courses available</span>
                    </div>
                  ) : (
                    <IonSelect
                      label="Course"
                      labelPlacement="stacked"
                      interface="action-sheet"
                      value={field.value}
                      onIonChange={(e) => field.onChange(e.detail.value ?? "")}
                      onIonBlur={field.onBlur}
                      className={fieldState.invalid ? "ion-invalid ion-touched" : ""}
                    >
                      {courses.map((course) => (
                        <IonSelectOption key={course.courseId} value={course.courseId}>
                          {course.name}
                          {course.location ? ` — ${course.location}` : ""}
                        </IonSelectOption>
                      ))}
                    </IonSelect>
                  )}
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
              disabled={createRound.isPending || coursesLoading || courses.length === 0}
              className="flex-1"
            >
              {createRound.isPending ? "Creating\u2026" : "Create & Start"}
            </IonButton>
          </div>
        </form>
      </IonContent>
    </>
  );
}
