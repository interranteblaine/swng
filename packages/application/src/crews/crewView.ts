import type { Crew, GameConfigDraft, StandingGame } from "@swng/domain";
import type { CrewView, GameConfigInput, StandingGameView } from "@swng/contracts";
import type { GolferStore } from "../ports/golferStore.js";

// GameConfigDraft's array/tuple fields are `readonly` (domain's own shape, scoring/game.ts);
// GameConfigInput's are plain mutable arrays (commands.ts: "mutable, as a client request
// body should be" — the SAME shape this builder now has to produce on the way OUT). A
// `readonly T[]` isn't assignable to a mutable `T[]` slot, so unlike saveStandingGame.ts's
// wire-to-domain direction (mutable -> readonly, which TS accepts without help), this
// reverse direction needs an explicit per-kind rebuild — mirrors addGame.ts's own
// `withGameId` switch (same "one arm per GameConfig kind" discipline), fresh arrays built by
// spreading rather than any cast.
const toGameConfigInput = (game: GameConfigDraft): GameConfigInput => {
  switch (game.kind) {
    case "stroke-play":
      return { ...game, players: [...game.players] };
    case "singles-match":
      return { ...game };
    case "stableford":
      return { ...game, players: [...game.players] };
    case "fourball-match": {
      const [a0, a1] = game.a;
      const [b0, b1] = game.b;
      return { ...game, a: [a0, a1], b: [b0, b1] };
    }
    case "skins":
      return { ...game, players: [...game.players] };
  }
};

const toStandingGameView = (standingGame: StandingGame): StandingGameView => ({
  ...(standingGame.courseId !== undefined ? { courseId: standingGame.courseId } : {}),
  ...(standingGame.tee !== undefined ? { tee: standingGame.tee } : {}),
  games: standingGame.games.map(toGameConfigInput),
});

// The one place a Crew aggregate + its store-level joinCode become CrewView (mirrors
// courses' courseView.ts / golfers' golferView.ts). Unlike those two, this builder is
// async: `claimed` isn't a field on the domain CrewMember (crew/crew.ts) — it's a
// GolferStore lookup done PER MEMBER at read time (does that member's golfer row carry a
// sub?), same "derive, don't store" reasoning as courseView's teeSets badges.
export const toCrewView = async (deps: { golferStore: GolferStore }, crew: Crew, joinCode: string): Promise<CrewView> => {
  const members = await Promise.all(
    crew.members.map(async (member) => {
      const found = await deps.golferStore.get(member.golferId);
      return { golferId: member.golferId, name: member.name, role: member.role, claimed: found?.sub !== undefined };
    }),
  );

  return {
    crewId: crew.id,
    name: crew.name,
    joinCode,
    members,
    ...(crew.standingGame !== undefined ? { standingGame: toStandingGameView(crew.standingGame) } : {}),
  };
};
