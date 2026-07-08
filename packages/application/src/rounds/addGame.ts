import type { GameConfig, GameId, GolferId } from "@swng/domain";
import { gameId } from "@swng/domain";
import type { AddGameRequest, AddGameResponse, GameConfigInput } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { ParticipantClaims } from "../ports/tokenIssuer.js";
import { isParticipant, requireParticipant } from "../scoringPolicy.js";
import { loadRoundState } from "./loadRoundState.js";
import { serverEnvelope } from "./serverEnvelope.js";

// Every golfer id a config mentions — players for the medal-family formats, the a/b sides
// for the match formats — is what AddGame checks against the roster before the game is
// allowed to exist (unknown-golfer-in-game).
const referencedGolfers = (game: GameConfigInput): readonly GolferId[] => {
  switch (game.kind) {
    case "stroke-play":
    case "stableford":
    case "skins":
      return game.players;
    case "singles-match":
      return [game.a, game.b];
    case "fourball-match":
      return [...game.a, ...game.b];
  }
};

// GameConfigInput's per-kind fields are exactly GameConfig's minus `id` (contracts §
// commands.ts) — assigning the server-minted id per kind keeps that correspondence typed
// rather than cast away wholesale.
const withGameId = (game: GameConfigInput, id: GameId): GameConfig => {
  switch (game.kind) {
    case "stroke-play":
      return { ...game, id };
    case "singles-match":
      return { ...game, id };
    case "stableford":
      return { ...game, id };
    case "fourball-match":
      return { ...game, id };
    case "skins":
      return { ...game, id };
  }
};

export const addGame =
  (deps: { journal: EventJournal; broadcast: Broadcast; clock: Clock; ids: IdGenerator }) =>
  async (claims: ParticipantClaims, command: AddGameRequest): Promise<AddGameResponse> => {
    const { state } = await loadRoundState(deps.journal, claims.roundId);
    requireParticipant(state, claims.golferId);
    if (state.status === "final") throw new ApplicationError("round-final");

    for (const golfer of referencedGolfers(command.game)) {
      if (!isParticipant(state, golfer)) throw new ApplicationError("unknown-golfer-in-game");
    }

    const id = gameId(deps.ids.newId());
    const config = withGameId(command.game, id);

    const result = await deps.journal.append(claims.roundId, [{ kind: "game-added", config, ...serverEnvelope(deps, claims.golferId) }]);
    await deps.broadcast.publish(claims.roundId, result.appended);

    // A fresh gameId's opId is never a duplicate — invariant of this call, not a runtime
    // condition to re-check — so the just-appended event is always present.
    const appended = result.appended.find((event) => event.kind === "game-added" && event.config.id === id);
    return { gameId: id, seq: appended!.seq! };
  };
