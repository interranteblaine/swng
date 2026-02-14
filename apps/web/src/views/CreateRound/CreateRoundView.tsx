import { useMemo } from "react";
import * as z from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useCreateRound } from "@/hooks/useCreateRound";
import { Controller, useForm } from "react-hook-form";

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
    <section
      id="create-view"
      aria-labelledby="create-heading"
      className="lg:max-w-2xl"
    >
      <header className="mb-6">
        <h2 id="create-heading" className="text-l md:text-xl font-semibold">
          Set up a new round.
        </h2>
      </header>

      <form
        id="create-round-form"
        aria-describedby="create-description"
        className="space-y-6"
        onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
      >
        <p id="create-description">
          Configure course and player information to create a round.
        </p>

        <div className="space-y-4">
          <Controller
            name="courseName"
            control={form.control}
            render={({ field, fieldState }) => (
              <div data-invalid={fieldState.invalid || undefined}>
                <label htmlFor="create-course-name" className="block text-sm font-medium mb-1">
                  Course name
                </label>
                <input
                  {...field}
                  id="create-course-name"
                  aria-invalid={fieldState.invalid || undefined}
                  placeholder="Pebble Beach"
                  autoComplete="off"
                  aria-describedby={
                    fieldState.invalid ? "create-course-name-error" : undefined
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                {fieldState.invalid && (
                  <span
                    id="create-course-name-error"
                    className="text-sm text-destructive"
                  >
                    {fieldState.error?.message}
                  </span>
                )}
              </div>
            )}
          />

          <Controller
            name="holeCount"
            control={form.control}
            render={({ field, fieldState }) => (
              <div data-invalid={fieldState.invalid || undefined}>
                <label
                  id="create-hole-count-label"
                  htmlFor="create-hole-count"
                  className="block text-sm font-medium mb-1"
                >
                  Holes
                </label>
                <div
                  id="create-hole-count"
                  role="radiogroup"
                  aria-labelledby="create-hole-count-label"
                  aria-invalid={fieldState.invalid || undefined}
                  aria-describedby={
                    fieldState.invalid ? "create-hole-count-error" : undefined
                  }
                  className="flex gap-4"
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="holeCount"
                      value="18"
                      id="create-hole-count-18"
                      checked={field.value === 18}
                      onChange={() => field.onChange(18)}
                      onBlur={field.onBlur}
                      disabled={field.disabled}
                    />
                    <label htmlFor="create-hole-count-18">18</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="holeCount"
                      value="9"
                      id="create-hole-count-9"
                      checked={field.value === 9}
                      onChange={() => field.onChange(9)}
                      onBlur={field.onBlur}
                      disabled={field.disabled}
                    />
                    <label htmlFor="create-hole-count-9">9</label>
                  </div>
                </div>
                {fieldState.invalid && (
                  <span
                    id="create-hole-count-error"
                    className="text-sm text-destructive"
                  >
                    {fieldState.error?.message}
                  </span>
                )}
              </div>
            )}
          />

          <Controller
            name="playerName"
            control={form.control}
            render={({ field, fieldState }) => (
              <div data-invalid={fieldState.invalid || undefined}>
                <label htmlFor="create-player-name" className="block text-sm font-medium mb-1">
                  Player name
                </label>
                <input
                  {...field}
                  id="create-player-name"
                  aria-invalid={fieldState.invalid || undefined}
                  placeholder="Your name"
                  autoComplete="off"
                  aria-describedby={
                    fieldState.invalid ? "create-player-name-error" : undefined
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                {fieldState.invalid && (
                  <span
                    id="create-player-name-error"
                    className="text-sm text-destructive"
                  >
                    {fieldState.error?.message}
                  </span>
                )}
              </div>
            )}
          />

          <Controller
            name="teeColor"
            control={form.control}
            render={({ field, fieldState }) => (
              <div data-invalid={fieldState.invalid || undefined}>
                <label htmlFor="create-tee-color" className="block text-sm font-medium mb-1">
                  Tee color
                </label>
                <input
                  {...field}
                  id="create-tee-color"
                  aria-invalid={fieldState.invalid || undefined}
                  placeholder="White"
                  autoComplete="off"
                  aria-describedby={
                    fieldState.invalid ? "create-tee-color-error" : undefined
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                {fieldState.invalid && (
                  <span
                    id="create-tee-color-error"
                    className="text-sm text-destructive"
                  >
                    {fieldState.error?.message}
                  </span>
                )}
              </div>
            )}
          />
        </div>

        {errorMessage && (
          <span className="text-sm text-destructive" aria-live="assertive">
            {errorMessage}
          </span>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium"
            onClick={onReset}
          >
            Reset
          </button>
          <button
            type="submit"
            form="create-round-form"
            disabled={createRound.isPending}
            className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {createRound.isPending ? "Creating\u2026" : "Create round"}
          </button>
        </div>
      </form>
    </section>
  );
}
