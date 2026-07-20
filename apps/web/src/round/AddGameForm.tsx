import { useState } from "react";
import type { FormEvent } from "react";
import { defaultAllowance } from "@swng/client";
import { allowancePhrase, gameId, gameKindBlurb, gameKindFits, gameKindLabel, golferId, strokePlayTreatment, strokesNote } from "@swng/domain";
import type { CourseCard, GameConfig, GolferId, Participant } from "@swng/domain";
import type { GameConfigInput } from "@swng/contracts";
import { ApiError } from "../api";
import { btnPrimary, cardBox, inputBox } from "../ui/classes";
import { strokesSummary } from "./dots";

type Kind = GameConfig["kind"];
const KINDS: readonly Kind[] = ["stroke-play", "singles-match", "stableford", "fourball-match", "skins"];

// The strokes preview needs a full GameConfig (gameDots' signature); ids are unvalidated
// brands, so a fixed placeholder id serves — it never leaves this component.
const PREVIEW_ID = gameId("preview");

export interface AddGameFormProps {
  readonly participants: readonly Participant[];
  readonly card: CourseCard;
  readonly onAddGame: (game: GameConfigInput) => Promise<void>;
}

export function AddGameForm({ participants, card, onAddGame }: AddGameFormProps) {
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
  const [adjusting, setAdjusting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const changeKind = (next: Kind) => {
    setKind(next);
    setAllowance(defaultAllowance(next)); // re-anchor to the new kind's default; still adjustable
    setAdjusting(false);
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
        return players.length > 0 ? { kind, players: [...players], allowance } : undefined;
      case "skins":
        // A skins pot needs at least two players contesting it — guarded here, not the wire.
        return players.length >= 2 ? { kind, players: [...players], allowance } : undefined;
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
  // GameConfigInput is GameConfig minus the server-assigned id — the placeholder restores it
  // purely so the preview can reuse the exact allocation the card's dots render.
  const preview = config ? strokesSummary({ ...config, id: PREVIEW_ID } as GameConfig, participants, card) : undefined;
  // Live-walk finding (2026-07-19): gross stroke play has no allowance by definition — the
  // shared `strokePlayTreatment` (also used by GamePanel's live standings) renders the gross line
  // in place of a meaningless "95% handicap" phrase and an all-zero strokesSummary line.
  const isGrossStrokePlay = kind === "stroke-play" && scoring === "gross";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!config) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onAddGame(config);
      // No optimistic insert on success: the game-added event flows back through the session
      // (pull/WS) and the roster renders it from state.games once it arrives.
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
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value ? golferId(event.target.value) : undefined)} className={inputBox}>
        <option value="">Select…</option>
        {participants.map(playerOption)}
      </select>
    </label>
  );

  return (
    <form onSubmit={submit} className={`${cardBox} flex flex-col gap-4 p-4`}>
      <h2 className="text-lg font-semibold text-forest">Add game</h2>

      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Game</legend>
        {KINDS.map((k) => (
          <label key={k} className={`${cardBox} flex cursor-pointer flex-col gap-1 p-3 ${kind === k ? "ring-2 ring-forest" : ""}`}>
            <span className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-2 font-semibold">
                <input type="radio" name="game-kind" aria-label={gameKindLabel(k)} checked={kind === k} onChange={() => changeKind(k)} className="h-4 w-4" />
                {gameKindLabel(k)}
              </span>
              <span className="text-xs text-fairway">{gameKindFits(k)}</span>
            </span>
            <span className="text-sm text-fairway">{gameKindBlurb(k)}</span>
          </label>
        ))}
      </fieldset>

      {kind === "stroke-play" && (
        <label className="flex flex-col gap-1">
          Scoring
          <select value={scoring} onChange={(event) => setScoring(event.target.value as "gross" | "net")} className={inputBox}>
            <option value="net">Net — with handicap strokes</option>
            <option value="gross">Gross — raw scores</option>
          </select>
        </label>
      )}

      {(kind === "stroke-play" || kind === "stableford" || kind === "skins") && (
        <fieldset role="group" aria-label="Who's in?" className="flex flex-col gap-2">
          <legend>Who&apos;s in?</legend>
          {participants.map((p) => (
            <label key={p.golferId} className="flex items-center gap-2">
              <input type="checkbox" checked={players.includes(p.golferId)} onChange={() => togglePlayer(p.golferId)} className="h-5 w-5" />
              {p.name}
            </label>
          ))}
        </fieldset>
      )}

      {kind === "singles-match" && (
        <fieldset className="flex flex-col gap-2">
          <legend>Who&apos;s playing?</legend>
          {selectPlayer("Player 1", singleA, setSingleA)}
          {selectPlayer("Player 2", singleB, setSingleB)}
        </fieldset>
      )}

      {kind === "fourball-match" && (
        <>
          <fieldset role="group" aria-label="Team 1" className="flex flex-col gap-2">
            <legend>Team 1</legend>
            {selectPlayer("First player", fbA1, setFbA1)}
            {selectPlayer("Second player", fbA2, setFbA2)}
          </fieldset>
          <fieldset role="group" aria-label="Team 2" className="flex flex-col gap-2">
            <legend>Team 2</legend>
            {selectPlayer("First player", fbB1, setFbB1)}
            {selectPlayer("Second player", fbB2, setFbB2)}
          </fieldset>
        </>
      )}

      {config && (
        <div className={`${cardBox} flex flex-col gap-1 p-3`}>
          <span className="flex items-center justify-between">
            <span className="font-semibold text-forest">Strokes</span>
            {!isGrossStrokePlay && (
              <button type="button" onClick={() => setAdjusting((current) => !current)} className="text-sm text-forest underline decoration-fairway decoration-2">
                Adjust
              </button>
            )}
          </span>
          {isGrossStrokePlay ? (
            <span className="text-sm text-fairway">{strokePlayTreatment("gross")}</span>
          ) : (
            <>
              <span className="text-sm text-fairway">{allowancePhrase(kind, allowance)}</span>
              {preview && <span className="text-sm text-forest">{preview}</span>}
              {strokesNote(kind) && <span className="text-sm text-fairway">{strokesNote(kind)}</span>}
            </>
          )}
          {!isGrossStrokePlay && adjusting && (
            <label className="flex flex-col gap-1 text-sm text-forest">
              Handicap %
              <input
                type="number"
                min={0}
                max={100}
                step="any"
                value={Math.round(allowance * 1000) / 10}
                onChange={(event) => setAllowance(Number(event.target.value) / 100)}
                className={inputBox}
              />
            </label>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-oxblood">
          {error}
        </p>
      )}

      <button type="submit" disabled={!config || submitting} className={`${btnPrimary} disabled:opacity-50`}>
        Add game
      </button>
    </form>
  );
}
