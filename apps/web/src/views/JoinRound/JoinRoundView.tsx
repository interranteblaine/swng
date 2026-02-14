import { useMemo } from "react";
import * as z from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { useJoinRound } from "@/hooks/useJoinRound";

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
    console.log("reset");
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
    <section
      id="join-view"
      aria-labelledby="join-heading"
      className="lg:max-w-2xl"
    >
      <header className="mb-6">
        <h2 id="join-heading" className="text-l md:text-xl font-semibold">
          Join Round
        </h2>
      </header>

      <form
        id="join-round-form"
        aria-describedby="join-description"
        className="space-y-6"
        onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
      >
        <p id="join-description">
          Enter access code and your name to join a round.
        </p>

        <div className="space-y-4">
          <Controller
            name="accessCode"
            control={form.control}
            render={({ field, fieldState }) => (
              <div data-invalid={fieldState.invalid || undefined}>
                <label htmlFor="join-round-access-code" className="block text-sm font-medium mb-1">
                  Access code
                </label>
                <input
                  {...field}
                  id="join-round-access-code"
                  aria-invalid={fieldState.invalid || undefined}
                  placeholder="XYSHSFL"
                  autoComplete="off"
                  aria-describedby={
                    fieldState.invalid
                      ? "join-round-access-code-error"
                      : undefined
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                {fieldState.invalid && (
                  <span
                    id="join-round-access-code-error"
                    className="text-sm text-destructive"
                  >
                    {fieldState.error?.message}
                  </span>
                )}
              </div>
            )}
          />
        </div>

        <div className="space-y-4">
          <Controller
            name="playerName"
            control={form.control}
            render={({ field, fieldState }) => (
              <div data-invalid={fieldState.invalid || undefined}>
                <label htmlFor="join-round-player-name" className="block text-sm font-medium mb-1">
                  Name
                </label>
                <input
                  {...field}
                  id="join-round-player-name"
                  aria-invalid={fieldState.invalid || undefined}
                  placeholder="Your name"
                  autoComplete="off"
                  aria-describedby={
                    fieldState.invalid
                      ? "join-round-player-name-error"
                      : undefined
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                {fieldState.invalid && (
                  <span
                    id="join-round-player-name-error"
                    className="text-sm text-destructive"
                  >
                    {fieldState.error?.message}
                  </span>
                )}
              </div>
            )}
          />
        </div>

        <div className="space-y-4">
          <Controller
            name="teeColor"
            control={form.control}
            render={({ field, fieldState }) => (
              <div data-invalid={fieldState.invalid || undefined}>
                <label htmlFor="join-round-tee-color" className="block text-sm font-medium mb-1">
                  Tee color
                </label>
                <input
                  {...field}
                  id="join-round-tee-color"
                  aria-invalid={fieldState.invalid || undefined}
                  placeholder="White"
                  autoComplete="off"
                  aria-describedby={
                    fieldState.invalid
                      ? "join-round-tee-color-error"
                      : undefined
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                {fieldState.invalid && (
                  <span
                    id="join-round-tee-color-error"
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
            form="join-round-form"
            disabled={joinRound.isPending}
            className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {joinRound.isPending ? "Joining\u2026" : "Join round"}
          </button>
        </div>
      </form>
    </section>
  );
}
