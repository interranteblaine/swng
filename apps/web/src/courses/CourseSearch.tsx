import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { CourseId } from "@swng/domain";
import { ApiError, searchCourses } from "../api";
import { cardBox, inputBox } from "../ui/classes";

export interface CourseSearchProps {
  readonly onSelect: (courseId: CourseId, name: string) => void;
}

// >=250ms (brief) — long enough that a fast typist never fires one request per keystroke,
// short enough to still feel live.
const DEBOUNCE_MS = 250;

// Search-first course picking (M6 Task 5): a plain text query against GET /courses?query=,
// debounced, with an empty-result state that hands off to add-a-course instead of dead-ending
// the golfer — course entry is meant to be reachable from the very moment a search comes up
// empty, not a separate thing you have to already know exists.
export function CourseSearch({ onSelect }: CourseSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly { readonly courseId: CourseId; readonly name: string; readonly holeCount: 9 | 18 }[] | undefined>(undefined);
  // Distinct from `results === undefined`: gates the "no courses found" empty-state so it
  // never flashes before the golfer has typed anything, or while a search is still in flight —
  // only once a real search has actually come back (successfully) empty.
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const trimmed = query.trim();
    setSearched(false);
    if (trimmed.length < 1) {
      setResults(undefined);
      return undefined; // min 1 char (brief) — nothing to debounce for an empty box
    }

    const timer = setTimeout(() => {
      searchCourses(trimmed)
        .then((response) => {
          setResults(response.courses);
          setSearched(true);
          setError(undefined);
        })
        .catch((caught: unknown) => {
          setResults(undefined);
          setSearched(true);
          setError(caught instanceof ApiError ? caught.message : "Could not search courses — try again.");
        });
    }, DEBOUNCE_MS);

    // Every keystroke re-runs this effect, clearing the PRIOR timer before it ever fires —
    // this IS the debounce (only the last keystroke within the window survives to search).
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        Course
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search courses…" className={`${inputBox} text-lg`} />
      </label>

      {results && results.length > 0 && (
        <ul className="flex flex-col gap-1">
          {results.map((course) => (
            <li key={course.courseId}>
              <button type="button" onClick={() => onSelect(course.courseId, course.name)} className={`${cardBox} w-full p-3 text-left`}>
                {course.name} <span className="font-mono text-fairway">· {course.holeCount} holes</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {searched && results && results.length === 0 && (
        <p className="text-fairway">
          No courses found.{" "}
          <Link to="/courses/new" className="text-forest underline decoration-fairway">
            Add a course
          </Link>
        </p>
      )}

      {error && (
        <p role="alert" className="text-oxblood">
          {error}
        </p>
      )}
    </div>
  );
}
