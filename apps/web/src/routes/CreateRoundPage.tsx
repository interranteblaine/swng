import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router";
import { fixtureLinks, fixtureLinks18 } from "@swng/domain";
import type { CourseCard } from "@swng/domain";
import { ApiError, createRound } from "../api";
import { credentialStore } from "../identity";

// M5's fixture-only course menu (docs/implementation-plan.md's M5 goal: "a crew can actually
// play Saturday with it (fixture courses)"). Real courses/tee pickers arrive in M6 — this
// list is the whole surface until then.
const COURSES: readonly CourseCard[] = [fixtureLinks, fixtureLinks18];

export function CreateRoundPage() {
  const navigate = useNavigate();
  const [card, setCard] = useState<CourseCard>(fixtureLinks);
  const [tee, setTee] = useState<string>(fixtureLinks.teeSets[0]!.name);
  const [name, setName] = useState("");
  const [courseHandicap, setCourseHandicap] = useState("0");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const changeCourse = (courseName: string) => {
    const next = COURSES.find((candidate) => candidate.courseName === courseName) ?? fixtureLinks;
    setCard(next);
    // Tee always tracks the newly chosen card's own tee sets, never a stale name from the
    // previous card — today's fixtures carry exactly one tee set each, but this stays correct
    // once a card offers more.
    setTee(next.teeSets[0]!.name);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedHandicap = Number.parseInt(courseHandicap, 10);
    if (!name.trim() || !Number.isInteger(parsedHandicap)) return;

    setSubmitting(true);
    setError(undefined);
    try {
      const response = await createRound({ card, host: { name: name.trim(), tee, courseHandicap: parsedHandicap } });
      credentialStore.save(response.roundId, { token: response.token, golferId: response.golferId, name: name.trim(), joinCode: response.joinCode });
      navigate(`/round/${response.roundId}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not create the round — try again.");
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-slate-950 p-6 text-slate-100">
      <h1 className="text-2xl font-bold">Start a round</h1>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          Course
          <select value={card.courseName} onChange={(event) => changeCourse(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg">
            {COURSES.map((course) => (
              <option key={course.courseName} value={course.courseName}>
                {course.courseName}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          Tee
          <select value={tee} onChange={(event) => setTee(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg">
            {card.teeSets.map((teeSet) => (
              <option key={teeSet.name} value={teeSet.name}>
                {teeSet.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          Your name
          <input value={name} onChange={(event) => setName(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
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
          Create round
        </button>
      </form>
    </main>
  );
}
