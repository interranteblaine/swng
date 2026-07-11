import { useEffect, useState } from "react";
import type { CourseId, GolferId, Participant } from "@swng/domain";
import type { CourseView, CrewMemberView, GameConfigInput, StandingGameView } from "@swng/contracts";
import { ApiError, getCourse } from "../api";
import { CourseSearch } from "../courses/CourseSearch";
import { AddGameForm } from "../round/SetupPanel";
import { describeStandingGame } from "./standingGamePreview";

export interface StandingGameEditorProps {
  readonly members: readonly CrewMemberView[];
  readonly standingGame?: StandingGameView;
  // The crew's own PUT /crews/{crewId}/standing-game round-trip lives in the caller (CrewPage
  // — it already holds the auth token and the crew's own state to refresh from the response),
  // not here: this component only assembles the wire shape and hands it up (resolution 5:
  // "Saving PUTs the whole preset").
  readonly onSave: (standingGame: StandingGameView) => Promise<void>;
}

// Course/tee pickers reused from round creation (resolution 5): CourseSearch verbatim, plus a
// plain tee `<select>` off the fetched CourseView's own teeSets — deliberately NOT the full
// CourseSummaryCard (its "Verify this card"/"Edit this card" affordances are about a COURSE's
// data trust, unrelated to editing a crew's own game preset; pulling that chrome in here would
// be confusing scope creep, not reuse).
export function StandingGameEditor({ members, standingGame, onSave }: StandingGameEditorProps) {
  const [courseView, setCourseView] = useState<CourseView | undefined>(undefined);
  const [tee, setTee] = useState(standingGame?.tee ?? "");
  const [courseError, setCourseError] = useState<string | undefined>(undefined);
  // Local, unsaved edits to the preset's game list — round-trips into `onSave` only once "Save"
  // is tapped (mirrors AddGameForm's own "append, don't fire yet" idiom one level up: here even
  // the append itself is local, not a request).
  const [games, setGames] = useState<readonly GameConfigInput[]>(standingGame?.games ?? []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const selectCourse = (id: CourseId) => {
    setCourseError(undefined);
    getCourse(id)
      .then((response) => {
        setCourseView(response.course);
        setTee((current) => (response.course.card.teeSets.some((t) => t.name === current) ? current : (response.course.card.teeSets[0]?.name ?? "")));
      })
      .catch((caught: unknown) => {
        setCourseView(undefined);
        setCourseError(caught instanceof ApiError ? caught.message : "Could not load that course — try again.");
      });
  };

  // Seeds the course view from the preset's own courseId exactly once, on mount — a fresh
  // instance per crew (CrewPage doesn't remount this mid-edit), so there's no "which revision
  // wins" race to guard against the way CreateRoundPage's own effect does.
  useEffect(() => {
    if (standingGame?.courseId) selectCourse(standingGame.courseId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once per mount only, see comment above
  }, []);

  // Fake Participant rows built from the crew roster (not real round participants — a preset
  // has no round yet) purely to satisfy AddGameForm's existing prop shape (name/golferId are
  // all it renders; tee/courseHandicap are unused placeholders here).
  const fakeParticipants: readonly Participant[] = members.map((m) => ({ golferId: m.golferId, name: m.name, tee: "", courseHandicap: 0 }));

  const nameFor = (id: GolferId): string => members.find((m) => m.golferId === id)?.name ?? id;

  const removeGame = (index: number) => {
    setGames((current) => current.filter((_, i) => i !== index));
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(undefined);
    try {
      const view: StandingGameView = {
        ...(courseView ? { courseId: courseView.courseId } : {}),
        ...(tee ? { tee } : {}),
        games: [...games],
      };
      await onSave(view);
      setSaved(true);
    } catch {
      setError("Could not save the standing game — try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-4 rounded-lg bg-slate-900 p-4">
      <h2 className="text-lg font-semibold">The standing game</h2>

      {courseView ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium">{courseView.name}</p>
            <button type="button" onClick={() => setCourseView(undefined)} className="text-sm text-emerald-400 underline">
              Change course
            </button>
          </div>
          <label className="flex flex-col gap-1">
            Tee
            <select value={tee} onChange={(event) => setTee(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg">
              {courseView.card.teeSets.map((teeSet) => (
                <option key={teeSet.name} value={teeSet.name}>
                  {teeSet.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <CourseSearch onSelect={(id) => selectCourse(id)} />
      )}
      {courseError && (
        <p role="alert" className="text-red-400">
          {courseError}
        </p>
      )}

      <div>
        <h3 className="text-base font-semibold">Configured games</h3>
        {games.length === 0 ? (
          <p className="text-slate-400">No games yet — add one below.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {games.map((game, index) => (
              <li key={index} className="flex items-center justify-between gap-2 rounded-lg bg-slate-800 p-2 text-sm">
                <span>{describeStandingGame(game, nameFor)}</span>
                <button type="button" onClick={() => removeGame(index)} className="text-xs text-red-400 underline">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <AddGameForm participants={fakeParticipants} onAddGame={(game) => Promise.resolve(setGames((current) => [...current, game]))} />

      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
      {saved && !error && (
        <p role="status" className="text-emerald-400">
          Saved.
        </p>
      )}

      <button type="button" onClick={() => void save()} disabled={saving} className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50">
        {saving ? "Saving…" : "Save"}
      </button>
    </section>
  );
}
