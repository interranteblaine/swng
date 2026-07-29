import type { ReactNode } from "react";
import { gameKindLabel, gameTreatment, strokesNote } from "@swng/domain";
import type { GameConfig, GameState, GolferId, Participant, RoundState } from "@swng/domain";
import { strokesSummary } from "../round/dots";
import { GolferLink } from "../ui/GolferLink";
import { badge, btnDanger, cardBox } from "../ui/classes";
import { vsPar } from "./describeGame";

export interface GamePanelProps {
  readonly game: GameState;
  readonly state: RoundState;
  // Opens the destructive confirm sheet for THIS game — owned and rendered by StandingsHeader
  // (kept, unmoved from before this arc); the panel only ever TRIGGERS it via this callback,
  // never renders a dialog itself. Omitted entirely by every read-only reuse (results/watch/
  // archived), which is what hides the "End game…" affordance there with no second "is this
  // live" prop — StandingsHeader's own doc comment, carried forward from the old GameSheet.
  readonly onTerminate?: () => void;
}

const nameOf = (participants: readonly Participant[], id: GolferId): string => participants.find((p) => p.golferId === id)?.name ?? id;

// "Holes 2–3 — carried" / "Hole 4 — Alex takes 3": the skins trail as the story of the game,
// carry runs collapsed — a list, not a grid, because that's how skins are retold. A "win" item
// carries the winner's raw golferId (not a pre-formatted string) so the render site below can
// wrap the name in a GolferLink — the link sweep (navigation spec, task 6): every visible
// story-line name becomes a link.
type SkinsStoryItem = { readonly kind: "carry"; readonly key: string; readonly text: string } | { readonly kind: "win"; readonly key: string; readonly hole: number; readonly winnerId: GolferId; readonly pot: number };

const skinsStory = (holes: readonly { hole: number; winner?: GolferId; pot: number }[]): readonly SkinsStoryItem[] => {
  const items: SkinsStoryItem[] = [];
  let carryStart: number | undefined;
  let carryEnd = 0;
  const flushCarry = () => {
    if (carryStart === undefined) return;
    items.push({
      kind: "carry",
      key: `carry-${carryStart}`,
      text: carryStart === carryEnd ? `Hole ${carryStart} — carried` : `Holes ${carryStart}–${carryEnd} — carried`,
    });
    carryStart = undefined;
  };
  for (const entry of holes) {
    if (entry.winner === undefined) {
      if (carryStart === undefined) carryStart = entry.hole;
      carryEnd = entry.hole;
      continue;
    }
    flushCarry();
    items.push({ kind: "win", key: `win-${entry.hole}`, hole: entry.hole, winnerId: entry.winner, pot: entry.pot });
  }
  flushCarry();
  return items;
};

export function GamePanel({ game, state, onTerminate: onOpenConfirm }: GamePanelProps) {
  const config = state.games.find((g): g is GameConfig => g.id === game.id);
  const title = game.kind === "stroke-play" ? `${gameKindLabel(game.kind)} (${game.scoring})` : gameKindLabel(game.kind);
  const terminated = state.terminatedGameIds.has(game.id);

  // spec 2026-07-19 §2c: the treatment line states the strokes convention in force, up front. ONE
  // function covers every kind now, gross included (this arc's spec §3) — the old
  // allowancePhrase/strokePlayTreatment split existed only to keep the percentage off the gross
  // line, and there is no percentage left.
  const treatment = config && gameTreatment(config);

  // strokesSummary renders nothing for a gross game (dots.ts) — gross never allocates a single
  // dot, so there is nothing to summarize.
  const strokes = config && strokesSummary(config, state.participants, state.card);

  const note = config && strokesNote(config);

  return (
    <section role="region" aria-label={`${title} standings`} className={`${cardBox} flex flex-col gap-3 p-4 text-forest`}>
      <div className="flex flex-col">
        <span className="text-lg font-semibold text-forest">
          {title}
          {terminated && <span className={`ml-2 ${badge}`}>Ended</span>}
        </span>
        {treatment && <span className="text-sm text-fairway">{treatment}</span>}
        {strokes && <span className="text-sm text-fairway">{strokes}</span>}
        {note && <span className="text-sm text-fairway">{note}</span>}
      </div>

      {game.kind === "stroke-play" && <StrokePlayBody game={game} state={state} />}
      {game.kind === "stableford" && <StablefordBody game={game} state={state} />}
      {(game.kind === "singles-match" || game.kind === "fourball-match") && config && <MatchBody game={game} config={config} state={state} />}
      {game.kind === "skins" && <SkinsBody game={game} state={state} />}

      {onOpenConfirm && state.status === "live" && !terminated && (
        <button type="button" onClick={onOpenConfirm} className={`${btnDanger} self-start`}>
          End game…
        </button>
      )}
    </section>
  );
}

function StrokePlayBody({ game, state }: { game: Extract<GameState, { kind: "stroke-play" }>; state: RoundState }) {
  const total = (line: (typeof game.lines)[number]) => (game.scoring === "net" ? line.net!.total : line.gross.total);
  // Owner ruling (spec 2026-07-19 §2b, closing the queued sort ruling): vs-par ascending, then
  // holes-played descending — NOT raw total. A thru-0 line's raw total is always the lowest
  // possible number regardless of how the real field is playing; sorting by vs-par instead is
  // fair across different thru counts, and the thru tie-break means a golfer who's actually
  // played the round outranks one who's only nominally tied because they haven't started.
  const sorted = [...game.lines].sort((a, b) => a.relativeToPar - b.relativeToPar || b.thru - a.thru);
  if (sorted.length === 0) return <p className="text-sm text-fairway">No scores yet</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-fairway">
            <th className="py-1 pr-2 font-medium">Player</th>
            <th className="py-1 pr-2 font-medium">Total</th>
            <th className="py-1 pr-2 font-medium">Thru</th>
            <th className="py-1 font-medium">vs par</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((line) => (
            <tr key={line.golferId} className="border-t border-hairline">
              <td className="py-2 pr-2">
                <GolferLink golferId={line.golferId} name={nameOf(state.participants, line.golferId)} />
              </td>
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
      <p className="text-sm text-fairway">Eagle 4 · Birdie 3 · Par 2 · Bogey 1 · worse 0</p>
      {sorted.length === 0 ? (
        <p className="text-sm text-fairway">No scores yet</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-fairway">
                <th className="py-1 pr-2 font-medium">Player</th>
                <th className="py-1 pr-2 font-medium">Points</th>
                <th className="py-1 font-medium">Thru</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((line) => (
                <tr key={line.golferId} className="border-t border-hairline">
                  <td className="py-2 pr-2">
                    <GolferLink golferId={line.golferId} name={nameOf(state.participants, line.golferId)} />
                  </td>
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
  // Kept plain (never linked): only ever embedded inside the compound `status` sentence below
  // ("Pat is 2 UP with 2 to play — dormie: ..."), which stays plain prose (the link sweep's own
  // carve-out for compound sentences, navigation spec task 6).
  const sideName = (side: "a" | "b"): string => {
    if (config.kind === "singles-match") return nameOf(state.participants, side === "a" ? config.a : config.b);
    if (config.kind === "fourball-match") return (side === "a" ? config.a : config.b).map((g) => nameOf(state.participants, g)).join(" & ");
    return side;
  };

  // The SAME side identities as sideName, but as visible trail-label links (the match-card
  // rowheader) — fourball pairs render as two GolferLinks joined by " & ", the same separator
  // sideName's own plain string uses, so the rendered TEXT is identical either way.
  const sideLinks = (side: "a" | "b"): ReactNode => {
    if (config.kind === "singles-match") {
      const id = side === "a" ? config.a : config.b;
      return <GolferLink golferId={id} name={nameOf(state.participants, id)} />;
    }
    if (config.kind === "fourball-match") {
      return (side === "a" ? config.a : config.b).map((id, i) => (
        <span key={id}>
          {i > 0 && " & "}
          <GolferLink golferId={id} name={nameOf(state.participants, id)} />
        </span>
      ));
    }
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
      return `${winner} ${game.kind === "fourball-match" ? "win" : "wins"} ${game.outcome.closing}`;
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
              <tr className="text-fairway">
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
                <tr key={side} className="border-t border-hairline">
                  <th scope="row" className="py-1 pr-2 text-left font-medium whitespace-nowrap">
                    {sideLinks(side)}
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
      <p className="text-sm">
        {totals.map((l, i) => (
          <span key={l.golferId}>
            {i > 0 && " · "}
            <GolferLink golferId={l.golferId} name={nameOf(state.participants, l.golferId)} />{" "}
            {l.skins}
          </span>
        ))}
      </p>
      {game.holes.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-fairway">
          {skinsStory(game.holes).map((item) =>
            item.kind === "carry" ? (
              <li key={item.key}>{item.text}</li>
            ) : (
              <li key={item.key}>
                Hole {item.hole} — <GolferLink golferId={item.winnerId} name={nameOf(state.participants, item.winnerId)} /> takes {item.pot}
              </li>
            ),
          )}
        </ul>
      )}
    </>
  );
}
