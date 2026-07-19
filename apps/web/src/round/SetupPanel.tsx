import { formatCourseHandicap, gameKindLabel, strokeGrant } from "@swng/domain";
import type { GameState, RoundState } from "@swng/domain";
import type { GameConfigInput } from "@swng/contracts";
import { AddGameForm } from "./AddGameForm";
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

// `games` (live GameState, the Task 5/6 standings seam) isn't read here — this task's dots
// derive from state.games (the frozen GameConfig) only — but it stays in SetupPanelProps so
// RoundPage's call site doesn't need a signature change once standings actually render.
export function SetupPanel({ state, joinCode, onAddGame }: SetupPanelProps) {
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
      {/* The share-the-code panel (accounts-only identity spec §3): the join code IS the invite
          and the sign-up funnel. Nobody adds anyone to the card — a new player joins with this
          code and creates their account on the way, so the framing replaces the old "Add player"
          ghost form entirely. */}
      <div className="rounded-lg bg-slate-800 p-4 text-center">
        <p className="text-sm uppercase tracking-wide text-slate-400">Join code</p>
        <p className="text-3xl font-bold tracking-widest">{joinCode}</p>
        <p className="mt-2 text-sm text-slate-400">Players join with this code — new players create their account on the way.</p>
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
                return { id: config.id, label: gameKindLabel(config.kind), total: perHole ? totalDots(perHole) : 0 };
              });

            return (
              <li key={p.golferId} className="flex flex-col gap-1">
                <span className="flex items-center gap-2">
                  <span>
                    {p.name} — {p.tee} — CH {formatCourseHandicap(p.courseHandicap)}
                  </span>
                  {/* A departed participant (accounts-only identity spec §4) stays on the roster
                      WITH their seat data — their played holes are facts — plus this "left"
                      marker. `departed` is set only when true in the fold (RosterEntry's optional
                      flag), so a present participant renders exactly as before. */}
                  {p.departed && <span className="rounded bg-slate-700 px-1.5 py-0.5 text-xs font-medium text-slate-300">left</span>}
                </span>
                {hasGames && (
                  <span className="flex flex-wrap gap-2 text-sm text-slate-400">
                    {badges.length > 0 ? (
                      badges.map((b) => {
                        // A give-back total (a plus player in a full-handicap game) reads "gives N"
                        // through the domain's strokeGrant, never a bare "-N dots"; a normal
                        // (receives/none) total renders byte-identically to before.
                        const grant = strokeGrant(b.total);
                        return (
                          <span key={b.id} className="rounded-full bg-slate-800 px-2 py-0.5">
                            {grant.kind === "gives" ? `${b.label}: gives ${grant.count}` : `${b.label}: ${b.total} dots`}
                          </span>
                        );
                      })
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

      <AddGameForm participants={state.participants} card={state.card} onAddGame={onAddGame} />
    </section>
  );
}
