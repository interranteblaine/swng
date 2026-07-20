import { useState } from "react";
import { formatCourseHandicap } from "@swng/domain";
import type { GameState, GolferId, Participant, RoundState } from "@swng/domain";
import type { GameConfigInput } from "@swng/contracts";
import { GolferLink } from "../ui/GolferLink";
import { badge, btnPrimary, btnSecondary, cardBox, eyebrow, inputBox } from "../ui/classes";
import { AddGameForm } from "./AddGameForm";

// Mid-round handicap correction (spec 2026-07-20): "-2" and "13" both parse fine via
// `parseInt`, but `parseInt` also silently accepts "12.5" (→ 12) and "" (→ NaN, already
// guarded) — this is stricter, the only shapes the round's own courseHandicap wire field
// (`z.number().int()`) accepts.
const isValidInt = (value: string): boolean => /^-?\d+$/.test(value.trim());

export interface SetupPanelProps {
  readonly state: RoundState;
  // Task 5/6 seam: live per-game standings (up/thru, points, skins won) render from here once
  // the scoring grid exists. Not read here — the roster is game-agnostic (spec 2026-07-19
  // §2a: the card never changes, and neither does the roster's own identity line) — but the
  // prop is part of the interface now so RoundPage doesn't need a signature change later.
  readonly games: readonly GameState[];
  readonly joinCode: string;
  readonly onAddGame: (game: GameConfigInput) => Promise<void>;
  // Mid-round handicap correction (spec 2026-07-20): the roster row is the editor. Implemented
  // by RoundPage as api.setHandicap + sync() — no optimistic local write; the corrected CH
  // arrives via the fold like every roster fact.
  readonly onSetHandicap: (golferId: GolferId, courseHandicap: number) => Promise<void>;
}

export function SetupPanel({ state, joinCode, onAddGame, onSetHandicap }: SetupPanelProps) {
  // Only one row edits at a time — opening a second row's editor is unreachable through the UI
  // (every other row's own Edit button is hidden while another row is mid-edit), so a single
  // `editing` id is enough state, no per-row map.
  const [editing, setEditing] = useState<GolferId | undefined>(undefined);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const startEdit = (p: Participant) => {
    setEditing(p.golferId);
    setValue(String(p.courseHandicap));
    setError(undefined);
  };

  const cancelEdit = () => {
    setEditing(undefined);
    setError(undefined);
  };

  const save = async (golferId: GolferId) => {
    if (!isValidInt(value)) return; // guarded by the disabled Save button too
    setSaving(true);
    setError(undefined);
    try {
      await onSetHandicap(golferId, parseInt(value, 10));
      // No optimistic local write: the corrected CH arrives via the fold once the caller
      // sync()s (RoundPage's own onSetHandicap), so closing here just dismisses the editor —
      // the roster row's own displayed value comes from `state.participants`, unchanged until
      // the next render carries the correction.
      setEditing(undefined);
    } catch {
      // Never a raw generic Error's message (papercut 12's own precedent) — an honest fallback;
      // the editor stays open, retry one tap away.
      setError("Could not update the course handicap — try again.");
    } finally {
      setSaving(false);
    }
  };

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
            <li key={p.golferId} className="flex flex-col gap-1 text-forest">
              <span className="flex flex-wrap items-center gap-2">
                <span>
                  <GolferLink golferId={p.golferId} name={p.name} /> — <span className="font-mono text-fairway">{p.tee}</span>
                  {/* The formatted CH span and the editor are mutually exclusive (review finding:
                      showing "CH +2" statically while the editor below holds the raw "-2" put two
                      sign-opposite representations of the same number on screen at once). While
                      editing, the editor renders IN PLACE of the "— CH ..." text entirely. */}
                  {editing === p.golferId ? (
                    <span className="ml-2 inline-flex items-center gap-2">
                      <input
                        type="number"
                        inputMode="numeric"
                        aria-label={`Course handicap for ${p.name}`}
                        className={`${inputBox} w-16`}
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                      />
                      <button type="button" className={btnPrimary} disabled={saving || !isValidInt(value)} onClick={() => void save(p.golferId)}>
                        Save
                      </button>
                      <button type="button" className={btnSecondary} onClick={cancelEdit}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="font-mono text-fairway"> — CH {formatCourseHandicap(p.courseHandicap)}</span>
                  )}
                </span>
                {/* A departed participant (accounts-only identity spec §4) stays on the roster
                    WITH their seat data — their played holes are facts — plus this "left"
                    marker. `departed` is set only when true in the fold (RosterEntry's optional
                    flag), so a present participant renders exactly as before. */}
                {p.departed && <span className={badge}>left</span>}
                {/* Mid-round handicap correction (spec 2026-07-20): a departed golfer keeps the
                    Edit affordance — a departed golfer is still correctable (their past scoring
                    used whatever CH was in effect at the time, but a fix should still apply). */}
                {editing !== p.golferId && (
                  <>
                    {" "}
                    <button type="button" className={btnSecondary} onClick={() => startEdit(p)}>
                      Edit
                    </button>
                  </>
                )}
              </span>

              {editing === p.golferId && (
                <span className="flex flex-col gap-2">
                  <span className="text-sm text-fairway">Strokes apply to the whole round — dots and games update everywhere.</span>
                  {error && (
                    <p role="alert" className="text-oxblood">
                      {error}
                    </p>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <AddGameForm participants={state.participants} card={state.card} onAddGame={onAddGame} />
    </section>
  );
}
