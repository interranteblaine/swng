import type { CourseCard, TeeSet } from "../../course/card.js";

// The 9-hole card from strokes.test.ts, shared here so every golden deck (stroke
// play, match play, ...) scores against one canonical fixture rather than each
// engine inventing its own card.
export const fixtureWhite: TeeSet = {
  name: "white", rating: 35.8, slope: 128,
  holes: [
    { number: 1, par: 4, yardage: 380, strokeIndex: 5 },
    { number: 2, par: 4, yardage: 410, strokeIndex: 1 },
    { number: 3, par: 3, yardage: 165, strokeIndex: 9 },
    { number: 4, par: 5, yardage: 520, strokeIndex: 3 },
    { number: 5, par: 4, yardage: 400, strokeIndex: 7 },
    { number: 6, par: 3, yardage: 180, strokeIndex: 8 },
    { number: 7, par: 4, yardage: 430, strokeIndex: 2 },
    { number: 8, par: 5, yardage: 490, strokeIndex: 4 },
    { number: 9, par: 4, yardage: 390, strokeIndex: 6 },
  ],
};

export const fixtureLinks: CourseCard = {
  courseName: "Fixture Links",
  teeSets: [fixtureWhite],
};
