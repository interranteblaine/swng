import { useRef, useState } from "react";
import type { GameState, GolferId, HoleSelection, RosterEntry, RoundState } from "@swng/domain";
import { holeSelectionLabel } from "@swng/domain";
import { MAX_STROKES } from "@swng/contracts";
import type { GameConfigInput } from "@swng/contracts";
import { ApiError } from "../api";
import { GolferLink } from "../ui/GolferLink";
import { badge, btnQuiet, btnSecondary, cardBox, eyebrow, inputBox } from "../ui/classes";
import { CopiedLinkLine } from "../ui/CopiedLinkLine";
import { AddGameForm } from "./AddGameForm";

// A datetime-local input's value is a LOCAL wall-clock string with no zone — "2026-07-31T14:05".
// Both directions go through here so the instant submitted is exactly the one the field shows;
// nothing is inferred (round-played-date spec 2026-08-01 §5). The SAME helper CreateRoundPage.tsx
// carries under its own copy — two occurrences of a small presentation conversion is this repo's
// own tolerated precedent (see the crew-page-papercuts arc's "hoist on a third copy" note); it is
// not golf compute, so the ESLint compute fence does not apply to either copy.
const pad = (n: number): string => String(n).padStart(2, "0");
const toDatetimeLocalValue = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

// The static display for the round's own played date — plain "Jul 22, 2026, 7:58 PM" via Intl's
// built-in dateStyle/timeStyle presets. NOT roundLabel: that function's job is course+day IDENTITY
// for a list of rounds (with its own day-collision rules); this is the one, always-present value
// on the round's own live page, shown for a golfer to review or correct — a different job, so
// there's no shared call here.
const formatPlayedAt = (playedAtMs: number): string => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(playedAtMs));

// A typed value is valid iff it parses to a real instant — the same "non-empty, parseable" check
// CreateRoundPage.tsx's own canSubmit applies to this exact input type.
const isValidPlayedAtValue = (value: string): boolean => value !== "" && !Number.isNaN(new Date(value).getTime());

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

// Which holes the round set out to play (spec 2026-08-02 §3): three choices, in the order the
// radio group renders them. Just the ORDER — the label text itself is domain presentation truth
// now (`holeSelectionLabel`, task 8b), the same shared list CreateRoundPage.tsx's own
// creation-time picker renders through.
const HOLE_SELECTIONS: readonly HoleSelection[] = ["all", "front", "back"];

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
  // The round's own played date, correctable while live (round-played-date spec 2026-08-01 §3b/
  // §5) — the SAME roster-strokes-editor idiom (Edit swaps the static value for an input; api
  // call then sync(); no optimistic local write), a ROUND-level fact rather than a per-golfer one,
  // so there's one editor, not one per roster row. Implemented by RoundPage as
  // api.setPlayedAt + sync().
  readonly onSetPlayedAt: (playedAtMs: number) => Promise<void>;
  // Which holes the round set out to play, correctable while live (spec 2026-08-02 §3b) — the
  // SAME idiom as onSetPlayedAt above, one more round-level fact with one editor. Rendered only
  // while the card has 18 holes (§3c: a card with one nine has no choice to make). Implemented by
  // RoundPage as api.setHoles + sync().
  readonly onSetHoles: (holes: HoleSelection) => Promise<void>;
}

export function SetupPanel({ state, joinCode, onAddGame, onSetStrokes, onSetPlayedAt, onSetHoles }: SetupPanelProps) {
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

  // The played-date editor's own state — a SEPARATE editor from the roster's `editing`/`value`
  // above (a round-level fact, not a per-golfer one, so there's nothing to key by golferId).
  const [editingPlayedAt, setEditingPlayedAt] = useState(false);
  const [playedAtValue, setPlayedAtValue] = useState("");
  const [playedAtError, setPlayedAtError] = useState<string | undefined>(undefined);
  const [savingPlayedAt, setSavingPlayedAt] = useState(false);
  // The exact string Edit seeded the field with — a ref, not state, since it never drives a
  // render on its own. savePlayedAt compares against it (Minor 5, task-7 review): the value it
  // captures at open time, not a live recomputation from `state.playedAtMs` (which could itself
  // move mid-edit if another device's correction arrives via sync).
  const seededPlayedAtValue = useRef("");

  // Seeds the field with the round's own current instant, converted to the local wall-clock
  // string the input speaks — the same "edit swaps in a field holding the current value" contract
  // startEdit follows for strokes above.
  const startEditPlayedAt = () => {
    const seeded = toDatetimeLocalValue(new Date(state.playedAtMs));
    setEditingPlayedAt(true);
    setPlayedAtValue(seeded);
    seededPlayedAtValue.current = seeded;
    setPlayedAtError(undefined);
  };

  const cancelEditPlayedAt = () => {
    setEditingPlayedAt(false);
    setPlayedAtError(undefined);
  };

  const savePlayedAt = async () => {
    if (!isValidPlayedAtValue(playedAtValue)) return; // guarded by the disabled Save button too
    // A no-change Save must not silently move the stored instant (Minor 5, task-7 review):
    // toDatetimeLocalValue drops seconds, which a `datetime-local` input can't display, so a
    // round whose playedAtMs carries sub-minute precision would otherwise get rewritten up to
    // 59.999s earlier by a Save the golfer typed nothing into. If the field still reads exactly
    // what Edit seeded it with, treat Save like Cancel — close without calling the API at all.
    if (playedAtValue === seededPlayedAtValue.current) {
      setEditingPlayedAt(false);
      return;
    }
    setSavingPlayedAt(true);
    setPlayedAtError(undefined);
    try {
      await onSetPlayedAt(new Date(playedAtValue).getTime());
      // No optimistic local write: the corrected instant arrives via the fold once the caller
      // sync()s (RoundPage's own onSetPlayedAt), same as the roster's own save() above.
      setEditingPlayedAt(false);
    } catch (caught) {
      // Unlike the strokes editor above, this editor validates nothing beyond "non-empty,
      // parseable" — a second UI-side ceiling duplicating the wire's own bound is forbidden
      // (the strokes editor's own isValidStrokes comment), so a wire rejection (a
      // too-far-future/too-old playedAtMs, or a 409 once another device finalizes first) is a
      // first-class reachable outcome here, not a hypothetical. A generic "try again" can never
      // succeed for any of those. Same idiom as CreateRoundPage's submit and this same panel's
      // own AddGameForm.tsx (composed a few lines below) — the server's own message when it's an
      // ApiError, an honest fallback otherwise, never a raw unexpected Error's message.
      setPlayedAtError(caught instanceof ApiError ? caught.message : "Could not update the played date — try again.");
    } finally {
      setSavingPlayedAt(false);
    }
  };

  // Which holes the round set out to play, correctable while live (spec 2026-08-02 §3b) — the
  // SAME roster-strokes/played-date editor idiom, its own separate state (a round-level fact,
  // like playedAtMs, so there's nothing to key by golferId).
  const [editingHoles, setEditingHoles] = useState(false);
  const [holesValue, setHolesValue] = useState<HoleSelection>(state.holes);
  const [holesError, setHolesError] = useState<string | undefined>(undefined);
  const [savingHoles, setSavingHoles] = useState(false);

  const startEditHoles = () => {
    setEditingHoles(true);
    setHolesValue(state.holes);
    setHolesError(undefined);
  };

  const cancelEditHoles = () => {
    setEditingHoles(false);
    setHolesError(undefined);
  };

  const saveHoles = async () => {
    // A no-change Save must not fire an empty correction — the played-date editor's own no-op
    // guard above, simpler here: HoleSelection is a plain three-value enum with no lossy
    // round-trip (playedAt's own dropped-seconds problem doesn't exist), so "no change" is a
    // direct equality check against the round's own current value.
    if (holesValue === state.holes) {
      setEditingHoles(false);
      return;
    }
    setSavingHoles(true);
    setHolesError(undefined);
    try {
      await onSetHoles(holesValue);
      // No optimistic local write: the corrected selection arrives via the fold once the caller
      // sync()s (RoundPage's own onSetHoles) — cells are keyed by hole number and every engine
      // already filters by selection, so switching front → all restores holes 10–18 exactly as
      // typed, never cleared or rewritten here.
      setEditingHoles(false);
    } catch (caught) {
      setHolesError(caught instanceof ApiError ? caught.message : "Could not update the holes — try again.");
    } finally {
      setSavingHoles(false);
    }
  };

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

      {/* The round's own played date, correctable while live (round-played-date spec 2026-08-01
          §3b/§5) — the roster-strokes-editor idiom applied to a round-level fact: Edit swaps the
          static value for a datetime-local editor, mutually exclusive with it. Named as its own
          region (the Roster `<ul aria-label="Roster">` precedent just below) so it's addressable
          as a stable ancestor. */}
      <section aria-label="Date played" className={`${cardBox} flex flex-col gap-2 p-4`}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-fairway">Date played</span>
          {/* No `disabled={savingPlayedAt}` here (Minor 8, task-7 review): this button only
              renders while `!editingPlayedAt`, and `savingPlayedAt` is only ever true WHILE
              editing — the two conditions can't be true at once, unlike the roster's own Edit
              buttons above/below, where a save on one row must disable every OTHER row's Edit
              while it's mid-flight. */}
          {!editingPlayedAt && (
            <button type="button" className={`${btnQuiet} text-sm`} onClick={startEditPlayedAt}>
              Edit
            </button>
          )}
        </div>

        {/* The static line and the editor are mutually exclusive — the same swap the roster's
            own strokes editor pins (2026-07-20 review finding: two representations of one value
            on screen at once). */}
        {editingPlayedAt ? (
          <div className="flex flex-col gap-2">
            <input
              type="datetime-local"
              aria-label="Date played"
              className={inputBox}
              value={playedAtValue}
              onChange={(event) => setPlayedAtValue(event.target.value)}
            />
            <div className="flex gap-2">
              {/* btnSecondary, not btnQuiet (owner's own Step 5 instruction) — one gold per
                  screen: AddGameForm's submit (below, this same panel) is this screen's one gold
                  action (Minor 2, task-7 review — this comment previously named
                  FinalizeControl's confirm-dialog Finalize button instead, which is wrong:
                  that button only exists conditionally, inside a dialog someone has to open
                  first, while AddGameForm's own gold submit renders unconditionally on every
                  live round, matching the OTHER "AddGameForm's submit ... gold action" comment
                  ~40 lines above in this same file), so a bordered Save here never competes
                  with it. */}
              <button type="button" className={btnSecondary} disabled={savingPlayedAt || !isValidPlayedAtValue(playedAtValue)} onClick={() => void savePlayedAt()}>
                Save
              </button>
              <button type="button" className={btnQuiet} disabled={savingPlayedAt} onClick={cancelEditPlayedAt}>
                Cancel
              </button>
            </div>
            {playedAtError && (
              <p role="alert" className="text-oxblood">
                {playedAtError}
              </p>
            )}
          </div>
        ) : (
          <p className="text-lg text-forest">{formatPlayedAt(state.playedAtMs)}</p>
        )}
      </section>

      {/* Which holes the round set out to play, correctable while live (spec 2026-08-02 §3b) —
          the SAME roster-strokes/played-date editor idiom, beside the played-date row. Rendered
          ONLY while the card has 18 holes (§3c: "a card with one nine has no choice to make, so
          none is offered") — a 9-hole card shows no section here at all, not a disabled one. The
          Edit button reads "Edit holes" (not the bare "Edit" the row above uses) because this
          region isn't scoped when it's found on screen — a distinct name is what disambiguates it
          from the Date played and roster rows' own Edit buttons. */}
      {state.card.teeSets[0]?.holes.length === 18 && (
        <section aria-label="Holes" className={`${cardBox} flex flex-col gap-2 p-4`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-fairway">Holes</span>
            {!editingHoles && (
              <button type="button" className={`${btnQuiet} text-sm`} onClick={startEditHoles}>
                Edit holes
              </button>
            )}
          </div>

          {editingHoles ? (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                {HOLE_SELECTIONS.map((value) => (
                  <label key={value} className="flex items-center gap-1 text-sm text-forest">
                    <input type="radio" name="holes-edit" value={value} checked={holesValue === value} onChange={() => setHolesValue(value)} />
                    {holeSelectionLabel(value)}
                  </label>
                ))}
              </div>
              <div className="flex gap-2">
                {/* btnSecondary, not btnQuiet — the SAME demoted-commit register the played-date
                    editor's own Save uses, for the SAME reason: AddGameForm's submit is this
                    screen's one gold action, so a bordered Save here never competes with it. */}
                <button type="button" className={btnSecondary} disabled={savingHoles} onClick={() => void saveHoles()}>
                  Save
                </button>
                <button type="button" className={btnQuiet} disabled={savingHoles} onClick={cancelEditHoles}>
                  Cancel
                </button>
              </div>
              <span className="text-sm text-fairway">Changing this redraws the card. Nothing you&apos;ve scored is lost.</span>
              {holesError && (
                <p role="alert" className="text-oxblood">
                  {holesError}
                </p>
              )}
            </div>
          ) : (
            <p className="text-lg text-forest">{holeSelectionLabel(state.holes)}</p>
          )}
        </section>
      )}

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

      <AddGameForm participants={state.participants} card={state.card} selection={state.holes} onAddGame={onAddGame} />
    </section>
  );
}
