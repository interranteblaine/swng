import { describe, expect, it } from "vitest";
import { coursesPlayed } from "./coursesPlayed.js";

describe("coursesPlayed", () => {
  it("groups two courses interleaved newest-first, correct counts, first-seen order", () => {
    // Newest-first input (GET /me/rounds' own order): Casa Verde, Walker, Casa Verde again.
    // First-seen order is therefore Casa Verde (seen at index 0) then Walker (seen at index 1) —
    // which is also most-recent-first, since the input itself already arrives that way.
    const lines = [
      { courseId: "casa-verde", courseName: "Casa Verde GC" },
      { courseId: "walker", courseName: "Walker" },
      { courseId: "casa-verde", courseName: "Casa Verde GC" },
    ];

    expect(coursesPlayed(lines)).toEqual([
      { courseId: "casa-verde", name: "Casa Verde GC", rounds: 2 },
      { courseId: "walker", name: "Walker", rounds: 1 },
    ]);
  });

  it("skips lines without a courseId", () => {
    const lines = [
      { courseId: "casa-verde", courseName: "Casa Verde GC" },
      { courseName: "Pre-course-cards Muni" }, // no courseId — nothing to link to
      { courseId: "casa-verde", courseName: "Casa Verde GC" },
    ];

    expect(coursesPlayed(lines)).toEqual([{ courseId: "casa-verde", name: "Casa Verde GC", rounds: 2 }]);
  });

  it("empty input -> empty output", () => {
    expect(coursesPlayed([])).toEqual([]);
  });
});
