import { useMemo } from "react";
import * as z from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { useJoinRound } from "@/hooks/useJoinRound";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

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

        <FieldGroup>
          <Controller
            name="accessCode"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="join-round-access-code">
                  Access code
                </FieldLabel>
                <Input
                  {...field}
                  id="join-round-access-code"
                  aria-invalid={fieldState.invalid || undefined}
                  placeholder="XYSHSFL"
                  autoComplete="off"
                  aira-describedby={
                    fieldState.invalid
                      ? "join-round-access-code-error"
                      : undefined
                  }
                />

                {fieldState.invalid && (
                  <FieldError
                    id="join-round-access-code-error"
                    errors={[fieldState.error]}
                  />
                )}
              </Field>
            )}
          />
        </FieldGroup>

        <FieldGroup>
          <Controller
            name="playerName"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="join-round-player-name">Name</FieldLabel>
                <Input
                  {...field}
                  id="join-round-player-name"
                  aria-invalid={fieldState.invalid || undefined}
                  placeholder="Your name"
                  autoComplete="off"
                  aira-describedby={
                    fieldState.invalid
                      ? "join-round-player-name-error"
                      : undefined
                  }
                />

                {fieldState.invalid && (
                  <FieldError
                    id="join-round-player-name-error"
                    errors={[fieldState.error]}
                  />
                )}
              </Field>
            )}
          />
        </FieldGroup>

        <FieldGroup>
          <Controller
            name="teeColor"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="join-round-tee-color">
                  Tee color
                </FieldLabel>
                <Input
                  {...field}
                  id="join-round-tee-color"
                  aria-invalid={fieldState.invalid || undefined}
                  placeholder="White"
                  autoComplete="off"
                  aira-describedby={
                    fieldState.invalid
                      ? "join-round-tee-color-error"
                      : undefined
                  }
                />

                {fieldState.invalid && (
                  <FieldError
                    id="join-round-tee-color-error"
                    errors={[fieldState.error]}
                  />
                )}
              </Field>
            )}
          />
        </FieldGroup>

        {errorMessage && (
          <FieldError aria-live="assertive">{errorMessage}</FieldError>
        )}

        <Field orientation="horizontal">
          <Button type="button" variant="outline" onClick={onReset}>
            Reset
          </Button>
          <Button
            type="submit"
            form="join-round-form"
            disabled={joinRound.isPending}
          >
            {joinRound.isPending ? "Joining…" : "Join round"}
          </Button>
        </Field>
      </form>
    </section>
  );
}
