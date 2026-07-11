import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { defaultAllowance, golferId } from "@swng/domain";
import type { CrewId, GameConfig, GameState, GolferId, Participant, RoundState } from "@swng/domain";
import type { AddParticipantRequest, CrewMemberView, GameConfigInput } from "@swng/contracts";
import { ApiError, getCrew } from "../api";
import { useAuth } from "../auth/useAuth";
import { ClaimAffordance } from "./ClaimAffordance";
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
  // M8 Task 5: "Add player" — POST /rounds/{roundId}/players. No optimistic insert (same
  // precedent as onAddGame): the new row appears once participant-joined round-trips through
  // the session's own fold, never synthesized locally.
  readonly onAddParticipant: (input: AddParticipantRequest) => Promise<void>;
}

// Exported (M8 Task 6): StandingGameEditor reuses this SAME label map + AddGameForm below
// verbatim — a crew's standing-game preset editor needs the identical five-kind game-config
// idiom this round-setup panel already has, not a second copy of it (conventions §0).
export const GAME_KIND_LABEL: Record<GameConfig["kind"], string> = {
  "stroke-play": "Stroke play",
  "singles-match": "Singles match",
  stableford: "Stableford",
  "fourball-match": "Fourball match",
  skins: "Skins",
};

// `games` (live GameState, the Task 5/6 standings seam) isn't read here — this task's dots
// derive from state.games (the frozen GameConfig) only — but it stays in SetupPanelProps so
// RoundPage's call site doesn't need a signature change once standings actually render.
export function SetupPanel({ state, joinCode, onAddGame, onAddParticipant }: SetupPanelProps) {
  const hasGames = state.games.length > 0;
  // Per-game dots, computed once up front rather than per participant row below — each
  // config's gameDots() call is independent of which row is currently rendering. Terminated
  // games drop out of roster dot-badges (M7 Task 6 brief) — a game that's stopped consuming
  // scores shouldn't still claim a dots badge, even though its frozen config stays in
  // state.games for the audit trail (`hasGames` above stays keyed off the raw list on purpose:
  // a round whose only game(s) all ended still "has had games," so the roster keeps its
  // per-player badge row — now honestly showing "Not yet in a game" for everyone — rather than
  // reverting to the pre-game plain view).
  const perGameDots = state.games
    .filter((config) => !state.terminatedGameIds.has(config.id))
    .map((config) => ({ config, dots: gameDots(config, state.participants, state.card) }));

  return (
    <section className="flex flex-col gap-6 p-6 text-slate-100">
      <div className="rounded-lg bg-slate-800 p-4 text-center">
        <p className="text-sm uppercase tracking-wide text-slate-400">Join code</p>
        <p className="text-3xl font-bold tracking-widest">{joinCode}</p>
      </div>

      <div>
        <h2 className="text-lg font-semibold">Roster</h2>
        {/* One roster view, not two: every participant's name/tee/courseHandicap always
            renders here. The DOTS presentation is what switches — plain courseHandicap
            (above) before any game exists, per-game badges (below) once games exist — never
            a second list of names alongside this one. */}
        <ul className="flex flex-col gap-2">
          {state.participants.map((p) => {
            const badges = perGameDots
              .filter(({ config }) => gamePlayers(config).includes(p.golferId))
              .map(({ config, dots }) => {
                const perHole = dots.get(p.golferId);
                return { id: config.id, label: GAME_KIND_LABEL[config.kind], total: perHole ? totalDots(perHole) : 0 };
              });

            return (
              <li key={p.golferId} className="flex flex-col gap-1">
                <span className="flex items-center gap-2">
                  <span>
                    {p.name} — {p.tee} — CH {p.courseHandicap}
                  </span>
                  <ClaimAffordance rowGolferId={p.golferId} rowName={p.name} code={joinCode} />
                </span>
                {hasGames && (
                  <span className="flex flex-wrap gap-2 text-sm text-slate-400">
                    {badges.length > 0 ? (
                      badges.map((b) => (
                        <span key={b.id} className="rounded-full bg-slate-800 px-2 py-0.5">
                          {b.label}: {b.total} dots
                        </span>
                      ))
                    ) : (
                      <span>Not yet in a game</span>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <AddPlayerForm
        crewId={state.crewId}
        existingGolferIds={new Set(state.participants.map((p) => p.golferId))}
        onAddParticipant={onAddParticipant}
      />

      <AddGameForm participants={state.participants} onAddGame={onAddGame} />
    </section>
  );
}

interface AddPlayerFormProps {
  readonly crewId: CrewId | undefined;
  readonly existingGolferIds: ReadonlySet<GolferId>;
  readonly onAddParticipant: (input: AddParticipantRequest) => Promise<void>;
}

// "Add player" (M8 Task 5, "host types Dave in"): name + tee + courseHandicap →
// POST /rounds/{roundId}/players. When the round carries a crewId, the crew's not-yet-in-round
// members render FIRST as one-tap quick-adds (their name IS the tap — the shared tee/CH fields
// below still apply), a free-text ghost form always underneath. The crew fetch is a nicety, not
// a gate (JoinRoundPage's peek-fallback precedent): a non-member participant, a signed-out
// device, or a network failure all degrade silently to the free-text form alone.
function AddPlayerForm({ crewId, existingGolferIds, onAddParticipant }: AddPlayerFormProps) {
  const { withAuth, signedIn } = useAuth();
  const [crewMembers, setCrewMembers] = useState<readonly CrewMemberView[] | undefined>(undefined);
  const [selected, setSelected] = useState<{ readonly golferId: GolferId; readonly name: string } | undefined>(undefined);
  const [name, setName] = useState("");
  const [tee, setTee] = useState("");
  const [courseHandicap, setCourseHandicap] = useState("0");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    setCrewMembers(undefined);
    if (!crewId || !signedIn) return; // no crew, or nothing to prove membership with — free text only
    withAuth((token) => getCrew(token, crewId))
      .then((response) => setCrewMembers(response.crew.members))
      .catch(() => {}); // degrade silently — see the function's own doc comment
  }, [crewId, signedIn, withAuth]);

  const quickAddCandidates = (crewMembers ?? []).filter((m) => !existingGolferIds.has(m.golferId));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedHandicap = Number.parseInt(courseHandicap, 10);
    const effectiveName = selected ? selected.name : name.trim();
    if (!effectiveName || !tee.trim() || !Number.isInteger(parsedHandicap)) return;

    setSubmitting(true);
    setError(undefined);
    try {
      await onAddParticipant({
        name: effectiveName,
        tee: tee.trim(),
        courseHandicap: parsedHandicap,
        ...(selected ? { golferId: selected.golferId } : {}),
      });
      // No optimistic insert (SetupPanel's own precedent, same as AddGameForm below): the new
      // roster row appears once participant-joined round-trips through the session's fold.
      // Papercut 3 (M9 hardening): tee/courseHandicap deliberately survive a successful add —
      // a Saturday roster is almost always the same tee, so retyping it for every player added
      // in a row is exactly the papercut this fixes. Only the identity fields (name/selection)
      // reset, since the NEXT player is a different person by definition.
      setSelected(undefined);
      setName("");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not add the player — try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4 rounded-lg bg-slate-900 p-4">
      <h2 className="text-lg font-semibold">Add player</h2>

      {quickAddCandidates.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-sm text-slate-400">From your crew</span>
          <div className="flex flex-wrap gap-2">
            {quickAddCandidates.map((m) => (
              <button
                key={m.golferId}
                type="button"
                onClick={() => setSelected({ golferId: m.golferId, name: m.name })}
                className="rounded-full bg-slate-800 px-3 py-1 text-sm font-medium text-emerald-400"
              >
                {m.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {selected ? (
        <p className="flex items-center gap-2">
          <span>Adding {selected.name}</span>
          <button type="button" onClick={() => setSelected(undefined)} className="text-sm text-emerald-400 underline">
            Change
          </button>
        </p>
      ) : (
        <label className="flex flex-col gap-1">
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
        </label>
      )}

      <label className="flex flex-col gap-1">
        Tee
        <input value={tee} onChange={(event) => setTee(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
      </label>

      <label className="flex flex-col gap-1">
        Course handicap
        <input
          type="number"
          step={1}
          value={courseHandicap}
          onChange={(event) => setCourseHandicap(event.target.value)}
          className="rounded-lg bg-slate-800 p-3 text-lg"
        />
      </label>

      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}

      <button type="submit" disabled={submitting} className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50">
        Add player
      </button>
    </form>
  );
}

type Kind = GameConfig["kind"];
const KINDS: readonly Kind[] = ["stroke-play", "singles-match", "stableford", "fourball-match", "skins"];

export interface AddGameFormProps {
  readonly participants: readonly Participant[];
  readonly onAddGame: (game: GameConfigInput) => Promise<void>;
}

// One flat form covering all five kinds — only the fields relevant to the chosen kind render,
// matching this task's "functional clarity, not the Task 5 pad" styling bar (brief). Exported
// (M8 Task 6): StandingGameEditor reuses this directly for the crew preset's game-config idiom
// — `onAddGame` there just appends to the preset's local array instead of firing a request, the
// same participants-in/GameConfigInput-out shape either way.
export function AddGameForm({ participants, onAddGame }: AddGameFormProps) {
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
      setError(caught instanceof ApiError ? caught.message : "Could not add the game — try again.");
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
