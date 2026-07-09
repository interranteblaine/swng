import { useState } from "react";
import type { FormEvent } from "react";
import { defaultAllowance, golferId } from "@swng/domain";
import type { GameConfig, GameState, GolferId, Participant, RoundState } from "@swng/domain";
import type { GameConfigInput } from "@swng/contracts";
import { gameDots, gamePlayers, totalDots } from "./dots";

export interface SetupPanelProps {
  readonly state: RoundState;
  // Task 5/6 seam: live per-game standings (up/thru, points, skins won) render from here once
  // the scoring grid exists. Not deeply used yet — this task only needs state.games (the
  // frozen config, for dots) — but the prop is part of the interface now so RoundPage doesn't
  // need a signature change later.
  readonly games: readonly GameState[];
  readonly joinCode: string;
  readonly onAddGame: (game: GameConfigInput) => Promise<void>;
}

const GAME_KIND_LABEL: Record<GameConfig["kind"], string> = {
  "stroke-play": "Stroke play",
  "singles-match": "Singles match",
  stableford: "Stableford",
  "fourball-match": "Fourball match",
  skins: "Skins",
};

export function SetupPanel({ state, games, joinCode, onAddGame }: SetupPanelProps) {
  const inAnyGame = new Set(state.games.flatMap((config) => gamePlayers(config)));
  const withoutAGame = state.participants.filter((p) => !inAnyGame.has(p.golferId));

  return (
    <section className="flex flex-col gap-6 p-6 text-slate-100">
      <div className="rounded-lg bg-slate-800 p-4 text-center">
        <p className="text-sm uppercase tracking-wide text-slate-400">Join code</p>
        <p className="text-3xl font-bold tracking-widest">{joinCode}</p>
      </div>

      <div>
        <h2 className="text-lg font-semibold">Roster</h2>
        <ul className="flex flex-col gap-1">
          {state.participants.map((p) => (
            <li key={p.golferId}>
              {p.name} — {p.tee} — CH {p.courseHandicap}
            </li>
          ))}
        </ul>
      </div>

      {state.games.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold">Games ({games.length})</h2>
          <div className="flex flex-col gap-3">
            {state.games.map((config) => {
              const dots = gameDots(config, state.participants, state.card);
              return (
                <div key={config.id} className="rounded-lg bg-slate-800 p-3">
                  <h3 className="font-semibold">{GAME_KIND_LABEL[config.kind]}</h3>
                  <ul>
                    {gamePlayers(config).map((id) => {
                      const player = state.participants.find((p) => p.golferId === id);
                      const perHole = dots.get(id);
                      const total = perHole ? totalDots(perHole) : 0;
                      return (
                        <li key={id}>
                          {player?.name ?? id} — {total} dots
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
          {withoutAGame.length > 0 && (
            <div className="mt-2 text-slate-400">
              Not yet in a game: {withoutAGame.map((p) => p.name).join(", ")}
            </div>
          )}
        </div>
      )}

      <AddGameForm participants={state.participants} onAddGame={onAddGame} />
    </section>
  );
}

type Kind = GameConfig["kind"];
const KINDS: readonly Kind[] = ["stroke-play", "singles-match", "stableford", "fourball-match", "skins"];

interface AddGameFormProps {
  readonly participants: readonly Participant[];
  readonly onAddGame: (game: GameConfigInput) => Promise<void>;
}

// One flat form covering all five kinds — only the fields relevant to the chosen kind render,
// matching this task's "functional clarity, not the Task 5 pad" styling bar (brief).
function AddGameForm({ participants, onAddGame }: AddGameFormProps) {
  const [kind, setKind] = useState<Kind>("stableford");
  const [scoring, setScoring] = useState<"gross" | "net">("net");
  const [players, setPlayers] = useState<readonly GolferId[]>([]);
  const [singleA, setSingleA] = useState<GolferId | undefined>(undefined);
  const [singleB, setSingleB] = useState<GolferId | undefined>(undefined);
  const [fbA1, setFbA1] = useState<GolferId | undefined>(undefined);
  const [fbA2, setFbA2] = useState<GolferId | undefined>(undefined);
  const [fbB1, setFbB1] = useState<GolferId | undefined>(undefined);
  const [fbB2, setFbB2] = useState<GolferId | undefined>(undefined);
  const [allowance, setAllowance] = useState<number>(defaultAllowance("stableford"));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const changeKind = (next: Kind) => {
    setKind(next);
    setAllowance(defaultAllowance(next)); // re-anchor to the new kind's default; still editable
    setPlayers([]);
    setSingleA(undefined);
    setSingleB(undefined);
    setFbA1(undefined);
    setFbA2(undefined);
    setFbB1(undefined);
    setFbB2(undefined);
    setError(undefined);
  };

  const togglePlayer = (id: GolferId) => {
    setPlayers((current) => (current.includes(id) ? current.filter((p) => p !== id) : [...current, id]));
  };

  const buildConfig = (): GameConfigInput | undefined => {
    switch (kind) {
      case "stroke-play":
        return players.length > 0 ? { kind, scoring, players: [...players], allowance } : undefined;
      case "stableford":
      case "skins":
        return players.length > 0 ? { kind, players: [...players], allowance } : undefined;
      case "singles-match":
        return singleA && singleB && singleA !== singleB ? { kind, a: singleA, b: singleB, allowance } : undefined;
      case "fourball-match": {
        const ids = [fbA1, fbA2, fbB1, fbB2];
        if (ids.some((id) => !id)) return undefined;
        if (new Set(ids).size !== 4) return undefined; // four distinct players required
        return { kind, a: [fbA1!, fbA2!], b: [fbB1!, fbB2!], allowance };
      }
    }
  };

  const config = buildConfig();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!config) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onAddGame(config);
      // No optimistic insert on success: the game-added event flows back through the session
      // (pull/WS) and the roster above renders it from state.games once it arrives — game
      // setup is rare and server-authored, so there's nothing useful to show locally in the
      // meantime beyond resetting the form for the next game.
      changeKind(kind);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add the game — try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const playerOption = (p: Participant) => (
    <option key={p.golferId} value={p.golferId}>
      {p.name}
    </option>
  );

  const selectPlayer = (label: string, value: GolferId | undefined, onChange: (id: GolferId | undefined) => void) => (
    <label className="flex flex-col gap-1">
      {label}
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value ? golferId(event.target.value) : undefined)}
        className="rounded-lg bg-slate-700 p-2"
      >
        <option value="">Select…</option>
        {participants.map(playerOption)}
      </select>
    </label>
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-lg bg-slate-900 p-4">
      <h2 className="text-lg font-semibold">Add game</h2>

      <label className="flex flex-col gap-1">
        Kind
        <select value={kind} onChange={(event) => changeKind(event.target.value as Kind)} className="rounded-lg bg-slate-700 p-2">
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {GAME_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>

      {kind === "stroke-play" && (
        <label className="flex flex-col gap-1">
          Scoring
          <select value={scoring} onChange={(event) => setScoring(event.target.value as "gross" | "net")} className="rounded-lg bg-slate-700 p-2">
            <option value="net">Net</option>
            <option value="gross">Gross</option>
          </select>
        </label>
      )}

      {(kind === "stroke-play" || kind === "stableford" || kind === "skins") && (
        <fieldset role="group" aria-label="Players" className="flex flex-col gap-2">
          <legend>Players</legend>
          {participants.map((p) => (
            <label key={p.golferId} className="flex items-center gap-2">
              <input type="checkbox" checked={players.includes(p.golferId)} onChange={() => togglePlayer(p.golferId)} className="h-5 w-5" />
              {p.name}
            </label>
          ))}
        </fieldset>
      )}

      {kind === "singles-match" && (
        <>
          {selectPlayer("Player A", singleA, setSingleA)}
          {selectPlayer("Player B", singleB, setSingleB)}
        </>
      )}

      {kind === "fourball-match" && (
        <>
          {selectPlayer("Side A – Player 1", fbA1, setFbA1)}
          {selectPlayer("Side A – Player 2", fbA2, setFbA2)}
          {selectPlayer("Side B – Player 1", fbB1, setFbB1)}
          {selectPlayer("Side B – Player 2", fbB2, setFbB2)}
        </>
      )}

      <label className="flex flex-col gap-1">
        Allowance
        <input
          type="number"
          // "any", not a fractional step like 0.05: default allowances (0.9/0.95/1) are
          // themselves not exact multiples of 0.05 in IEEE754 (0.95 % 0.05 !== 0), which a
          // strict step-mismatch check would flag as invalid and silently block native form
          // submission — a real constraint-validation footgun for a free-form decimal
          // fraction, not just a test-environment quirk.
          step="any"
          value={allowance}
          onChange={(event) => setAllowance(Number(event.target.value))}
          className="rounded-lg bg-slate-700 p-2"
        />
      </label>

      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}

      <button type="submit" disabled={!config || submitting} className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50">
        Add game
      </button>
    </form>
  );
}
