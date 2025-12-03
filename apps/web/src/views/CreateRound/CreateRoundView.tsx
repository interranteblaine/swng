import { type FormEvent, useMemo } from "react";
import { useCreateRound } from "../../hooks/useCreateRound";

export function CreateRoundView() {
  const createRound = useCreateRound();

  const defaultHoleCount = 18;

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);

    const courseNameRaw = fd.get("courseName");
    const playerNameRaw = fd.get("playerName");
    const playerColorRaw = fd.get("playerColor");
    const holeCountRaw = fd.get("holeCount");

    const courseName =
      typeof courseNameRaw === "string" ? courseNameRaw.trim() : "";
    const playerName =
      typeof playerNameRaw === "string" ? playerNameRaw.trim() : "";
    const color =
      typeof playerColorRaw === "string" && playerColorRaw.trim().length > 0
        ? playerColorRaw.trim()
        : undefined;

    const holeCountNum = Number(
      typeof holeCountRaw === "string" ? holeCountRaw : defaultHoleCount
    );
    const holeCount =
      holeCountNum === 9 || holeCountNum === 18
        ? holeCountNum
        : defaultHoleCount;

    if (!courseName || !playerName) {
      // Basic guard; browser required already enforces this.
      return;
    }

    // Align to hook requirements: create requires a par array (length = holeCount).
    // Use a reasonable default (par 4 for all holes). Detailed par editing can be added later.
    const par = Array.from({ length: holeCount }, () => 4);

    void createRound
      .mutateAsync({
        courseName,
        par,
        playerName,
        color,
      })
      .catch(() => {
        // error surface via createRound.error; prevent unhandled rejection
      });
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
    <section id="create-view" aria-labelledby="create-heading">
      <header>
        <h2 id="create-heading">Create Round</h2>
        <p>Set up a new round.</p>
      </header>

      <form aria-describedby="create-description" onSubmit={handleSubmit}>
        <p id="create-description">
          Enter basic course and player information to create a round.
        </p>

        <div>
          <label htmlFor="create-course-name">Course name</label>
          <input
            id="create-course-name"
            name="courseName"
            type="text"
            required
          />
        </div>

        <div>
          <label htmlFor="create-player-name">Your name</label>
          <input
            id="create-player-name"
            name="playerName"
            type="text"
            required
          />
        </div>

        <div>
          <label htmlFor="create-player-color">Tee / color</label>
          <input
            id="create-player-color"
            name="playerColor"
            type="text"
            placeholder="e.g. Blue"
          />
        </div>

        <div>
          <label htmlFor="create-holes">Number of holes</label>
          <select id="create-holes" name="holeCount" required defaultValue="18">
            <option value="9">9</option>
            <option value="18">18</option>
          </select>
        </div>

        {errorMessage && (
          <p role="alert" aria-live="assertive">
            {errorMessage}
          </p>
        )}

        <div>
          <button type="submit" disabled={createRound.isPending}>
            {createRound.isPending ? "Creating…" : "Create round"}
          </button>
        </div>
      </form>
    </section>
  );
}
