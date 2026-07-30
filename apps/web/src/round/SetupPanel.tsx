import { useState } from "react";
import type { GameState, GolferId, RosterEntry, RoundState, StrokeBasis } from "@swng/domain";
import type { GameConfigInput } from "@swng/contracts";
import { GolferLink } from "../ui/GolferLink";
import { badge, btnQuiet, cardBox, eyebrow, inputBox } from "../ui/classes";
import { CopiedLinkLine } from "../ui/CopiedLinkLine";
import { vsPar } from "../ui/vsPar";
import { AddGameForm } from "./AddGameForm";

// Mid-round basis correction (spec 2026-07-20): "-2" and "13" both parse fine via `parseInt`, but
// `parseInt` also silently accepts "12.5" (→ 12) and "" (→ NaN, already guarded) — this is
// stricter, the only shapes the basis wire fields (`z.number().int()`) accept.
const isValidInt = (value: string): boolean => /^-?\d+$/.test(value.trim());

// Which of a StrokeBasis's two constructors (spec 2026-07-29 §2a) a row's open editor is writing.
// "A group saying 'just give him 18' is the SECOND constructor, not a fudge of the first", so the
// two are separate affordances rather than one field whose meaning the reader has to guess.
type EditKind = StrokeBasis["kind"];

// The two editors' own copy, in one place so the label, the teaching line and the number a Save
// posts can never drift apart.
const EDITORS: Readonly<Record<EditKind, { readonly label: (name: string) => string; readonly teaching: string }>> = {
  "normally-shoots": {
    label: (name) => `What ${name} normally shoots, relative to par`,
    teaching: "Strokes come from the difference across the group — dots and games update everywhere.",
  },
  strokes: {
    label: (name) => `Strokes for ${name}`,
    teaching: "Strokes given directly, for the whole round — dots and games update everywhere.",
  },
};

export interface SetupPanelProps {
  readonly state: RoundState;
  // Task 5/6 seam: live per-game standings (up/thru, points, skins won) render from here once
  // the scoring grid exists. Not read here — the roster is game-agnostic (spec 2026-07-19
  // §2a: the card never changes, and neither does the roster's own identity line) — but the
  // prop is part of the interface now so RoundPage doesn't need a signature change later.
  readonly games: readonly GameState[];
  readonly joinCode: string;
  readonly onAddGame: (game: GameConfigInput) => Promise<void>;
  // Mid-round basis correction (spec 2026-07-20): the roster row is the editor. Implemented by
  // RoundPage as api.setBasis + sync() — no optimistic local write; the corrected assertion (and
  // the strokes the whole field re-derives from it) arrive via the fold like every roster fact.
  readonly onSetBasis: (golferId: GolferId, basis: StrokeBasis) => Promise<void>;
}

export function SetupPanel({ state, joinCode, onAddGame, onSetBasis }: SetupPanelProps) {
  // A single `editing` id (not a per-row map) holds at most one open editor. Every OTHER row's
  // own Edit button stays visible and clickable the whole time — only the row currently being
  // edited hides its own Edit button, swapping in the Save/Cancel pair in its place. Tapping a
  // different row's Edit calls startEdit again, which just overwrites `editing`/`value` — an
  // IMPLICIT cancel of whichever row was open before, not a blocked action. Edit and Cancel are
  // both disabled while `saving` is true so a slow save in flight can't be interrupted by
  // switching rows mid-request — `save`'s own `setEditing(undefined)`/`setError` would otherwise
  // land on whatever row happens to be open when the request settles, not necessarily the row
  // that started it.
  const [editing, setEditing] = useState<{ readonly golferId: GolferId; readonly kind: EditKind } | undefined>(undefined);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

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

  // Seeds the field with whatever that constructor's CURRENT number is, or blank when the seat
  // states the other kind — there is nothing honest to convert between them (a normal score is a
  // fact about the player; strokes are a fact about this round).
  const startEdit = (p: RosterEntry, kind: EditKind) => {
    setEditing({ golferId: p.golferId, kind });
    const stated = p.basis.kind === "normally-shoots" ? p.basis.overPar : p.basis.strokes;
    setValue(p.basis.kind === kind ? String(stated) : "");
    setError(undefined);
  };

  const cancelEdit = () => {
    setEditing(undefined);
    setError(undefined);
  };

  const save = async (golferId: GolferId, kind: EditKind) => {
    if (!isValidInt(value)) return; // guarded by the disabled Save button too
    const number = parseInt(value, 10);
    setSaving(true);
    setError(undefined);
    try {
      await onSetBasis(golferId, kind === "normally-shoots" ? { kind, overPar: number } : { kind, strokes: number });
      // No optimistic local write: the corrected assertion arrives via the fold once the caller
      // sync()s (RoundPage's own onSetBasis), so closing here just dismisses the editor — the
      // roster row's own displayed values come from `state.participants`, unchanged until the
      // next render carries the correction.
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
        {/* The standard card (spec 2026-07-19 §2a: the card never changes) — every participant's
            identity row is name/tee/what-they-stated/what-they-get, full stop. Per-game strokes are
            that game's own concern (its panel states them in words), never a roster badge. */}
        <ul className="flex flex-col gap-2">
          {state.participants.map((p) => {
            const open = editing?.golferId === p.golferId ? editing : undefined;
            return (
              <li key={p.golferId} className="flex flex-col gap-1 text-forest">
                <span className="flex flex-wrap items-center gap-2">
                  <span>
                    <GolferLink golferId={p.golferId} name={p.name} /> — <span className="font-mono text-fairway">{p.tee}</span>
                    {/* The static numbers and the editor are mutually exclusive (2026-07-20 review
                        finding: showing a formatted number statically while the editor below held
                        the raw one put two representations of the same value on screen at once).
                        While editing, the editor renders IN PLACE of the static text entirely. */}
                    {open ? (
                      <span className="ml-2 inline-flex items-center gap-2">
                        <input
                          type="number"
                          inputMode="numeric"
                          aria-label={EDITORS[open.kind].label(p.name)}
                          className={`${inputBox} w-16`}
                          value={value}
                          onChange={(event) => setValue(event.target.value)}
                        />
                        {/* btnQuiet, never a boxed button (owner call, 2026-07-20 — the boxed idioms
                            are visually oversized inside a text row) and never gold (review finding —
                            AddGameForm's "Add game" submit below is this SAME panel's one gold
                            action; the reskin rule, spec 2026-07-19). */}
                        <button type="button" className={btnQuiet} disabled={saving || !isValidInt(value)} onClick={() => void save(p.golferId, open.kind)}>
                          Save
                        </button>
                        <button type="button" className={btnQuiet} disabled={saving} onClick={cancelEdit}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      // What they STATED, then what the whole field's rule turned it into (spec
                      // 2026-07-29 §2). A seat that stated strokes directly has no normal score to
                      // show, so the row says so rather than implying one was measured.
                      <span className="font-mono text-fairway">
                        {p.basis.kind === "normally-shoots" ? ` — normally ${vsPar(p.basis.overPar, 0)} · gets ${p.strokes}` : ` — gets ${p.strokes} (given directly)`}
                      </span>
                    )}
                  </span>
                  {/* A departed participant (accounts-only identity spec §4) stays on the roster
                      WITH their seat data — their played holes are facts — plus this "left"
                      marker. `departed` is set only when true in the fold (RosterEntry's optional
                      flag), so a present participant renders exactly as before. */}
                  {p.departed && <span className={badge}>left</span>}
                  {/* Mid-round basis correction (spec 2026-07-20): a departed golfer keeps both
                      affordances — their holes still count, so a fix should still apply. Two
                      buttons, not one field with a mode: the two constructors are different KINDS
                      of statement (spec 2026-07-29 §2a), so which one you are writing is chosen
                      before you type, never inferred from the number. */}
                  {!open && (
                    <>
                      {" "}
                      <button type="button" className={`${btnQuiet} text-sm`} disabled={saving} onClick={() => startEdit(p, "normally-shoots")}>
                        Edit
                      </button>{" "}
                      <button type="button" className={`${btnQuiet} text-sm`} disabled={saving} onClick={() => startEdit(p, "strokes")}>
                        Give strokes directly
                      </button>
                    </>
                  )}
                </span>

                {open && (
                  <span className="flex flex-col gap-2">
                    <span className="text-sm text-fairway">{EDITORS[open.kind].teaching}</span>
                    {error && (
                      <p role="alert" className="text-oxblood">
                        {error}
                      </p>
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
