import { formatCourseHandicap } from "@swng/domain";
import type { GameState, RoundState } from "@swng/domain";
import type { GameConfigInput } from "@swng/contracts";
import { cardBox, eyebrow } from "../ui/classes";
import { AddGameForm } from "./AddGameForm";

export interface SetupPanelProps {
  readonly state: RoundState;
  // Task 5/6 seam: live per-game standings (up/thru, points, skins won) render from here once
  // the scoring grid exists. Not read here — the roster is game-agnostic (spec 2026-07-19
  // §2a: the card never changes, and neither does the roster's own identity line) — but the
  // prop is part of the interface now so RoundPage doesn't need a signature change later.
  readonly games: readonly GameState[];
  readonly joinCode: string;
  readonly onAddGame: (game: GameConfigInput) => Promise<void>;
}

export function SetupPanel({ state, joinCode, onAddGame }: SetupPanelProps) {
  return (
    <section className="flex flex-col gap-6 p-6">
      {/* The share-the-code panel (accounts-only identity spec §3): the join code IS the invite
          and the sign-up funnel. Nobody adds anyone to the card — a new player joins with this
          code and creates their account on the way, so the framing replaces the old "Add player"
          ghost form entirely. */}
      <div className={`${cardBox} p-4 text-center`}>
        <p className={eyebrow}>Join code</p>
        <p className="font-mono text-3xl font-bold tracking-widest text-forest">{joinCode}</p>
        <p className="mt-2 text-sm text-fairway">Players join with this code — new players create their account on the way.</p>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-forest">Roster</h2>
        {/* The standard card (spec 2026-07-19 §2a: the card never changes) — every participant's
            identity row is name/tee/courseHandicap, full stop. Per-game strokes are that game's
            own concern now (its panel states them in words), never a roster badge. */}
        <ul className="flex flex-col gap-2">
          {state.participants.map((p) => (
            <li key={p.golferId} className="flex items-center gap-2 text-forest">
              <span>
                {p.name} — {p.tee} — CH {formatCourseHandicap(p.courseHandicap)}
              </span>
              {/* A departed participant (accounts-only identity spec §4) stays on the roster
                  WITH their seat data — their played holes are facts — plus this "left"
                  marker. `departed` is set only when true in the fold (RosterEntry's optional
                  flag), so a present participant renders exactly as before. */}
              {p.departed && <span className="bg-fairway px-1.5 py-0.5 text-xs font-medium text-cream">left</span>}
            </li>
          ))}
        </ul>
      </div>

      <AddGameForm participants={state.participants} card={state.card} onAddGame={onAddGame} />
    </section>
  );
}
