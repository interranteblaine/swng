import { type FormEvent, useMemo } from "react";
import { useJoinRound } from "../../hooks/useJoinRound";

export function JoinRoundView() {
  const joinRound = useJoinRound();

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);

    const accessCodeRaw = fd.get("accessCode");
    const playerNameRaw = fd.get("playerName");
    const playerColorRaw = fd.get("playerColor");

    const accessCode =
      typeof accessCodeRaw === "string" ? accessCodeRaw.trim() : "";
    const playerName =
      typeof playerNameRaw === "string" ? playerNameRaw.trim() : "";
    const color =
      typeof playerColorRaw === "string" && playerColorRaw.trim().length > 0
        ? playerColorRaw.trim()
        : undefined;

    if (!accessCode || !playerName) {
      return;
    }

    void joinRound
      .mutateAsync({
        accessCode,
        playerName,
        color,
      })
      .catch(() => {
        // error is surfaced via joinRound.error; avoid unhandled promise rejection
      });
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
    <section id="join-view" aria-labelledby="join-heading">
      <header>
        <h2 id="join-heading">Join Round</h2>
        <p>Join an existing round using an access code.</p>
      </header>

      <form aria-describedby="join-description" onSubmit={handleSubmit}>
        <p id="join-description">
          Enter the access code and your name to join a round.
        </p>

        <div>
          <label htmlFor="join-access-code">Access code</label>
          <input id="join-access-code" name="accessCode" type="text" required />
        </div>

        <div>
          <label htmlFor="join-player-name">Your name</label>
          <input id="join-player-name" name="playerName" type="text" required />
        </div>

        <div>
          <label htmlFor="join-player-color">Tee / color</label>
          <input
            id="join-player-color"
            name="playerColor"
            type="text"
            placeholder="e.g. White"
          />
        </div>

        {errorMessage && (
          <p role="alert" aria-live="assertive">
            {errorMessage}
          </p>
        )}

        <div>
          <button type="submit" disabled={joinRound.isPending}>
            {joinRound.isPending ? "Joining…" : "Join round"}
          </button>
        </div>
      </form>
    </section>
  );
}
