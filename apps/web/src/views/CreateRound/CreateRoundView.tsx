import { useMemo } from "react";
import * as z from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useCreateRound } from "@/hooks/useCreateRound";
import { Controller, useForm } from "react-hook-form";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

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

        <FieldGroup>
          <Controller
            name="courseName"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="create-course-name">
                  Course name
                </FieldLabel>
                <Input
                  {...field}
                  id="create-course-name"
                  aria-invalid={fieldState.invalid || undefined}
                  placeholder="Pebble Beach"
                  autoComplete="off"
                  aria-describedby={
                    fieldState.invalid ? "create-course-name-error" : undefined
                  }
                />
                {fieldState.invalid && (
                  <FieldError
                    id="create-course-name-error"
                    errors={[fieldState.error]}
                  />
                )}
              </Field>
            )}
          />

          <Controller
            name="holeCount"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel
                  id="create-hole-count-label"
                  htmlFor="create-hole-count"
                >
                  Holes
                </FieldLabel>
                <RadioGroup
                  id="create-hole-count"
                  value={String(field.value)}
                  onValueChange={(v) => field.onChange(Number(v))}
                  onBlur={field.onBlur}
                  disabled={field.disabled}
                  aria-labelledby="create-hole-count-label"
                  aria-invalid={fieldState.invalid || undefined}
                  aria-describedby={
                    fieldState.invalid ? "create-hole-count-error" : undefined
                  }
                >
                  <div className="flex items-center gap-3">
                    <RadioGroupItem value="18" id="create-hole-count-18" />
                    <Label htmlFor="create-hole-count-18">18</Label>
                  </div>
                  <div className="flex items-center gap-3">
                    <RadioGroupItem value="9" id="create-hole-count-9" />
                    <Label htmlFor="create-hole-count-9">9</Label>
                  </div>
                </RadioGroup>
                {fieldState.invalid && (
                  <FieldError
                    id="create-hole-count-error"
                    errors={[fieldState.error]}
                  />
                )}
              </Field>
            )}
          />

          <Controller
            name="playerName"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="create-player-name">
                  Player name
                </FieldLabel>
                <Input
                  {...field}
                  id="create-player-name"
                  aria-invalid={fieldState.invalid || undefined}
                  placeholder="Your name"
                  autoComplete="off"
                  aria-describedby={
                    fieldState.invalid ? "create-player-name-error" : undefined
                  }
                />
                {fieldState.invalid && (
                  <FieldError
                    id="create-player-name-error"
                    errors={[fieldState.error]}
                  />
                )}
              </Field>
            )}
          />

          <Controller
            name="teeColor"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="create-tee-color">Tee color</FieldLabel>
                <Input
                  {...field}
                  id="create-tee-color"
                  aria-invalid={fieldState.invalid || undefined}
                  placeholder="White"
                  autoComplete="off"
                  aria-describedby={
                    fieldState.invalid ? "create-tee-color-error" : undefined
                  }
                />
                {fieldState.invalid && (
                  <FieldError
                    id="create-tee-color-error"
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
            form="create-round-form"
            disabled={createRound.isPending}
          >
            {createRound.isPending ? "Creating…" : "Create round"}
          </Button>
        </Field>
      </form>
    </section>
  );
}
