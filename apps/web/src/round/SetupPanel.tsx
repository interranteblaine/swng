import { useState } from "react";
import type { GameState, GolferId, RosterEntry, RoundState } from "@swng/domain";
import { MAX_STROKES } from "@swng/contracts";
import type { GameConfigInput } from "@swng/contracts";
import { GolferLink } from "../ui/GolferLink";
import { badge, btnQuiet, cardBox, eyebrow, inputBox } from "../ui/classes";
import { CopiedLinkLine } from "../ui/CopiedLinkLine";
import { AddGameForm } from "./AddGameForm";

// A strokes count is a whole number in [0, MAX_STROKES] — the SAME range commands.ts's
// `strokesInputSchema` accepts, bound to it by the shared constant rather than by a second literal
// that can drift. Every arm of this predicate is a shape the wire rejects: `parseInt` alone would
// take "12.5" (→ 12) and "-3" (→ -3), and a bare `/^\d+$/` would take "60" — which enables Save,
// POSTs, 400s, and shows a generic "try again" that can never succeed however many times it is
// tried. The editor declines to OFFER an illegal state rather than reporting it after a round trip.
const isValidStrokes = (value: string): boolean => /^\d+$/.test(value.trim()) && Number(value.trim()) <= MAX_STROKES;

// WHY Save is dead, said out loud (whole-branch review Minor 7). `isValidStrokes` decides whether
// the control is offered; without this the editor just went quiet — a typed "150" left Save
// disabled with nothing on screen explaining it, and the row's own `role="alert"` line is populated
// only by a save FAILURE, which by definition never happens for a value Save won't send. A silent
// dead end on the flagship control of an arc about legibility.
//
// One sentence for every illegal shape (negative, fractional, non-numeric, over the ceiling): it
// states the whole legal range, which answers all four rather than guessing which mistake was made.
// An EMPTY field is not "invalid" here — a mid-edit blank has nothing to correct yet, so it is not
// scolded; Save is still disabled by the predicate.
const strokesReasonFor = (value: string): string | undefined =>
  value.trim() === "" || isValidStrokes(value) ? undefined : `Enter a whole number from 0 to ${MAX_STROKES}.`;

export interface SetupPanelProps {
  readonly state: RoundState;
  // Task 5/6 seam: live per-game standings (up/thru, points, skins won) render from here once
  // the scoring grid exists. Not read here — the roster is game-agnostic (spec 2026-07-19
  // §2a: the card never changes, and neither does the roster's own identity line) — but the
  // prop is part of the interface now so RoundPage doesn't need a signature change later.
  readonly games: readonly GameState[];
  readonly joinCode: string;
  readonly onAddGame: (game: GameConfigInput) => Promise<void>;
  // The roster row is the editor (spec 2026-07-30 §8). Implemented by RoundPage as
  // api.setStrokes + sync() — no optimistic local write; the new number arrives via the fold like
  // every other roster fact.
  readonly onSetStrokes: (golferId: GolferId, strokes: number) => Promise<void>;
}

export function SetupPanel({ state, joinCode, onAddGame, onSetStrokes }: SetupPanelProps) {
  // A single `editing` id (not a per-row map) holds at most one open editor. Every OTHER row's
  // own Edit button stays visible and clickable the whole time — only the row currently being
  // edited hides its own Edit button, swapping in the Save/Cancel pair in its place. Tapping a
  // different row's Edit calls startEdit again, which just overwrites `editing`/`value` — an
  // IMPLICIT cancel of whichever row was open before, not a blocked action. Edit and Cancel are
  // both disabled while `saving` is true so a slow save in flight can't be interrupted by
  // switching rows mid-request — `save`'s own `setEditing(undefined)`/`setError` would otherwise
  // land on whatever row happens to be open when the request settles, not necessarily the row
  // that started it.
  const [editing, setEditing] = useState<GolferId | undefined>(undefined);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  // At most one editor is open at a time (see `editing` above), so one derived reason and one id
  // serve the whole roster — no per-row state to keep in step.
  const strokesReason = strokesReasonFor(value);
  const strokesReasonId = "strokes-reason";

  const [inviteUrl, setInviteUrl] = useState<string | undefined>(undefined);
  const [inviteCopied, setInviteCopied] = useState(false);

  const copyInviteLink = async () => {
    // The receiving path already exists whole: /join?code= seeds the form and survives the
    // sign-in round trip (returnTo). The link is derived from the code on this device's own
    // origin — never minted server-side (ShareButton's precedent).
    const url = `${window.location.origin}/join?code=${joinCode}`;
    setInviteUrl(url);
    setInviteCopied(false);
    try {
      await navigator.clipboard.writeText(url);
      setInviteCopied(true);
    } catch {
      // Clipboard denied/unavailable — the visible raw-url line below still lets the golfer
      // copy by hand (ShareButton's discipline: success is never only a vanished toast).
    }
  };

  // Seeds the field with the seat's current number — there is only one thing to edit now.
  const startEdit = (p: RosterEntry) => {
    setEditing(p.golferId);
    setValue(String(p.strokes));
    setError(undefined);
  };

  const cancelEdit = () => {
    setEditing(undefined);
    setError(undefined);
  };

  const save = async (golferId: GolferId) => {
    if (!isValidStrokes(value)) return; // guarded by the disabled Save button too
    setSaving(true);
    setError(undefined);
    try {
      await onSetStrokes(golferId, parseInt(value, 10));
      // No optimistic local write: the new number arrives via the fold once the caller sync()s
      // (RoundPage's own onSetStrokes), so closing here just dismisses the editor — the roster
      // row's own displayed values come from `state.participants`, unchanged until the next
      // render carries the change.
      setEditing(undefined);
    } catch {
      // Never a raw generic Error's message (papercut 12's own precedent) — an honest fallback;
      // the editor stays open, retry one tap away.
      setError("Could not update this player's strokes — try again.");
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
        {/* Legacy tolerance, not a live state (spec 2026-07-20 §3): only a credential cached by a
            pre-fix re-mint entry holds an empty code; it dies on the next entry through any door. */}
        {joinCode !== "" && (
          <>
            {/* btnQuiet, never gold — AddGameForm's submit is this screen's one gold action. */}
            <button type="button" className={`${btnQuiet} mt-2 text-sm`} onClick={() => void copyInviteLink()}>
              Copy invite link
            </button>
            {inviteUrl && <CopiedLinkLine url={inviteUrl} copied={inviteCopied} className="mt-1" />}
          </>
        )}
      </div>

      <div>
        <h2 className="text-lg font-semibold text-forest">Roster</h2>
        {/* Two lines and one control (spec 2026-07-30 §8): name + Edit, then the facts. There is
            one thing to edit now, so there is one button — the prior model had two because its
            TYPE had two arms, which let the model's shape leak into the UI as a choice the user
            had to make. Per-game strokes are that game's own concern (its panel states them in
            words), never a roster badge. */}
        {/* Named so the list is addressable as a list — a screen reader announces "Roster" on
            entry instead of an anonymous group, and it gives the roster rows a stable ancestor.
            The rows themselves are NOT stably identifiable: the row being edited drops its own
            Edit button (below), so "the li with an Edit button" — which is how the browser gate
            used to find one — stops matching the instant you click it. */}
        <ul aria-label="Roster" className="flex flex-col gap-2">
          {state.participants.map((p) => {
            const open = editing === p.golferId;
            return (
              <li key={p.golferId} className="flex flex-col gap-1 text-forest">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <GolferLink golferId={p.golferId} name={p.name} />
                    {/* A departed participant (accounts-only identity spec §4) stays on the roster
                        WITH their seat data — their played holes are facts — plus this "left"
                        marker. `departed` is set only when true in the fold (RosterEntry's optional
                        flag), so a present participant renders exactly as before. */}
                    {p.departed && <span className={badge}>left</span>}
                  </span>
                  {/* btnQuiet, never a boxed button (owner call, 2026-07-20 — the boxed idioms are
                      visually oversized inside a text row) and never gold (AddGameForm's "Add game"
                      submit below is this SAME panel's one gold action). A departed golfer keeps the
                      affordance: their holes still count, so a fix should still apply. */}
                  {!open && (
                    <button type="button" className={`${btnQuiet} text-sm`} disabled={saving} onClick={() => startEdit(p)}>
                      Edit
                    </button>
                  )}
                </div>

                {/* The static line and the editor are mutually exclusive (2026-07-20 review
                    finding: two representations of the same value on screen at once). */}
                {open ? (
                  <div className="flex flex-col gap-2">
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-sm text-fairway">{p.tee} ·</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        // The stepper and the browser's own validation carry the SAME range
                        // isValidStrokes and the wire do — floored at 0 because nobody gives
                        // strokes back (spec 2026-07-30 §2), capped at the schema's own ceiling.
                        min={0}
                        max={MAX_STROKES}
                        aria-label={`Strokes for ${p.name}`}
                        // Describes the input rather than shouting: the reason appears the moment
                        // the field goes illegal, but a screen reader hears it as this control's
                        // own constraint, not as an interruption on every keystroke (role="alert"
                        // below stays for the one thing that IS an interruption, a failed save).
                        aria-describedby={strokesReason ? strokesReasonId : undefined}
                        className={`${inputBox} w-16`}
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                      />
                      <span className="text-sm text-fairway">strokes</span>
                      <button type="button" className={btnQuiet} disabled={saving || !isValidStrokes(value)} onClick={() => void save(p.golferId)}>
                        Save
                      </button>
                      <button type="button" className={btnQuiet} disabled={saving} onClick={cancelEdit}>
                        Cancel
                      </button>
                    </span>
                    {/* Oxblood, the careful-action ink (brand reskin): this is a correction to
                        make, not a fact about the round. Sits directly under the control it
                        explains, above the teaching line, so the eye meets the reason first. */}
                    {strokesReason && (
                      <span id={strokesReasonId} className="text-sm text-oxblood">
                        {strokesReason}
                      </span>
                    )}
                    <span className="text-sm text-fairway">Strokes apply to the whole round — dots and games update everywhere.</span>
                    {error && (
                      <p role="alert" className="text-oxblood">
                        {error}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-fairway">{`${p.tee} · ${p.strokes} ${p.strokes === 1 ? "stroke" : "strokes"}`}</p>
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
