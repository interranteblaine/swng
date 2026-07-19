import { allowancePhrase, gameKindBlurb, gameKindLabel } from "@swng/domain";
import type { GameConfig, GameState, GolferId, Participant, RoundState } from "@swng/domain";
import { strokesSummary } from "../round/dots";
import { vsPar } from "./describeGame";

export interface GameSheetProps {
  readonly game: GameState;
  readonly state: RoundState;
  readonly onClose: () => void;
}

const nameOf = (participants: readonly Participant[], id: GolferId): string => participants.find((p) => p.golferId === id)?.name ?? id;

// "Holes 2–3 — carried" / "Hole 4 — Alex takes 3": the skins trail as the story of the
// game, carry runs collapsed — a list, not a grid, because that's how skins are retold.
const skinsStory = (holes: readonly { hole: number; winner?: GolferId; pot: number }[], participants: readonly Participant[]): readonly string[] => {
  const items: string[] = [];
  let carryStart: number | undefined;
  let carryEnd = 0;
  const flushCarry = () => {
    if (carryStart === undefined) return;
    items.push(carryStart === carryEnd ? `Hole ${carryStart} — carried` : `Holes ${carryStart}–${carryEnd} — carried`);
    carryStart = undefined;
  };
  for (const entry of holes) {
    if (entry.winner === undefined) {
      if (carryStart === undefined) carryStart = entry.hole;
      carryEnd = entry.hole;
      continue;
    }
    flushCarry();
    items.push(`Hole ${entry.hole} — ${nameOf(participants, entry.winner)} takes ${entry.pot}`);
  }
  flushCarry();
  return items;
};

export function GameSheet({ game, state, onClose }: GameSheetProps) {
  const config = state.games.find((g): g is GameConfig => g.id === game.id);
  const title = game.kind === "stroke-play" ? `${gameKindLabel(game.kind)} (${game.scoring})` : gameKindLabel(game.kind);
  const terminated = state.terminatedGameIds.has(game.id);

  return (
    <div
      role="dialog"
      aria-label={`${title} standings`}
      className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col gap-3 overflow-y-auto rounded-t-2xl bg-slate-900 p-4 text-slate-100 shadow-2xl"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-lg font-semibold">
            {title}
            {terminated && <span className="ml-2 rounded bg-slate-600 px-1.5 py-0.5 text-xs font-medium">Ended</span>}
          </span>
          {config && <span className="text-sm text-slate-400">{allowancePhrase(config.kind, config.allowance)}</span>}
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="min-h-10 rounded-lg bg-slate-800 px-3 text-lg text-slate-300">
          ✕
        </button>
      </div>

      <p className="text-sm text-slate-400">{gameKindBlurb(game.kind)}</p>

      {game.kind === "stroke-play" && <StrokePlayBody game={game} state={state} />}
      {game.kind === "stableford" && <StablefordBody game={game} state={state} />}
      {(game.kind === "singles-match" || game.kind === "fourball-match") && config && <MatchBody game={game} config={config} state={state} />}
      {game.kind === "skins" && <SkinsBody game={game} state={state} />}
    </div>
  );
}

function StrokePlayBody({ game, state }: { game: Extract<GameState, { kind: "stroke-play" }>; state: RoundState }) {
  const total = (line: (typeof game.lines)[number]) => (game.scoring === "net" ? line.net!.total : line.gross.total);
  const sorted = [...game.lines].sort((a, b) => total(a) - total(b));
  if (sorted.length === 0) return <p className="text-sm text-slate-400">No scores yet</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-slate-400">
            <th className="py-1 pr-2 font-medium">Player</th>
            <th className="py-1 pr-2 font-medium">Total</th>
            <th className="py-1 pr-2 font-medium">Thru</th>
            <th className="py-1 font-medium">vs par</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((line) => (
            <tr key={line.golferId} className="border-t border-slate-800">
              <td className="py-2 pr-2">{nameOf(state.participants, line.golferId)}</td>
              <td className="py-2 pr-2">{total(line)}</td>
              <td className="py-2 pr-2">{line.thru}</td>
              <td className="py-2">{vsPar(line.relativeToPar)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StablefordBody({ game, state }: { game: Extract<GameState, { kind: "stableford" }>; state: RoundState }) {
  const sorted = [...game.lines].sort((a, b) => b.points - a.points);
  return (
    <>
      <p className="text-sm text-slate-400">Eagle 4 · Birdie 3 · Par 2 · Bogey 1 · worse 0</p>
      {sorted.length === 0 ? (
        <p className="text-sm text-slate-400">No scores yet</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-slate-400">
                <th className="py-1 pr-2 font-medium">Player</th>
                <th className="py-1 pr-2 font-medium">Points</th>
                <th className="py-1 font-medium">Thru</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((line) => (
                <tr key={line.golferId} className="border-t border-slate-800">
                  <td className="py-2 pr-2">{nameOf(state.participants, line.golferId)}</td>
                  <td className="py-2 pr-2">{line.points}</td>
                  <td className="py-2">{line.thru}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function MatchBody({ game, config, state }: { game: Extract<GameState, { kind: "singles-match" | "fourball-match" }>; config: GameConfig; state: RoundState }) {
  // Side names from the frozen config — the describeFourball precedent, applied to both kinds.
  const sideName = (side: "a" | "b"): string => {
    if (config.kind === "singles-match") return nameOf(state.participants, side === "a" ? config.a : config.b);
    if (config.kind === "fourball-match") return (side === "a" ? config.a : config.b).map((g) => nameOf(state.participants, g)).join(" & ");
    return side;
  };
  const leaderSide: "a" | "b" | undefined =
    game.kind === "singles-match"
      ? game.leader === undefined
        ? undefined
        : game.leader === (config.kind === "singles-match" ? config.a : undefined)
          ? "a"
          : "b"
      : game.leader;

  const status = (() => {
    if (game.outcome) {
      if ("halved" in game.outcome) return "Match halved";
      const winner = game.kind === "singles-match" ? nameOf(state.participants, (game.outcome as { winner: GolferId }).winner) : sideName((game.outcome as { winner: "a" | "b" }).winner);
      return `${winner} wins ${game.outcome.closing}`;
    }
    if (game.up === 0) return `All square thru ${game.thru}`;
    const leaderName = leaderSide ? sideName(leaderSide) : "";
    const trailerName = leaderSide ? sideName(leaderSide === "a" ? "b" : "a") : "";
    const base = `${leaderName} is ${game.up} UP with ${game.remaining} to play`;
    return game.dormie ? `${base} — dormie: ${trailerName} must win every remaining hole to tie.` : base;
  })();

  return (
    <>
      <p className="text-sm font-medium">{status}</p>
      {game.holes.length > 0 && (
        <div className="overflow-x-auto">
          <table className="text-xs">
            <thead>
              <tr className="text-slate-400">
                <th className="py-1 pr-2 text-left font-medium">Hole</th>
                {game.holes.map((h) => (
                  <th key={h.hole} className="px-1 py-1 text-center font-medium">
                    {h.hole}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(["a", "b"] as const).map((side) => (
                <tr key={side} className="border-t border-slate-800">
                  <th scope="row" className="py-1 pr-2 text-left font-medium whitespace-nowrap">
                    {sideName(side)}
                  </th>
                  {game.holes.map((h) => (
                    <td key={h.hole} className="px-1 py-1 text-center">
                      {h.winner === side ? "●" : h.winner === "halved" ? "·" : ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-sm text-slate-400">{strokesSummary(config, state.participants, state.card)}</p>
    </>
  );
}

function SkinsBody({ game, state }: { game: Extract<GameState, { kind: "skins" }>; state: RoundState }) {
  const status = game.complete
    ? game.carriedOut > 0
      ? `${game.carriedOut} carried out — the final pot was never won`
      : undefined
    : game.carrying > 0
      ? `Carrying ${game.carrying} into hole ${game.holesDecided + 1}`
      : undefined;
  const totals = [...game.lines].sort((a, b) => b.skins - a.skins);
  return (
    <>
      {status && <p className="text-sm font-medium">{status}</p>}
      <p className="text-sm">{totals.map((l) => `${nameOf(state.participants, l.golferId)} ${l.skins}`).join(" · ")}</p>
      {game.holes.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-slate-300">
          {skinsStory(game.holes, state.participants).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </>
  );
}
