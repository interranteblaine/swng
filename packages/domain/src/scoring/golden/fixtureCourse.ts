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

// The 18-hole card for the M5 field deck. The front nine keeps fixtureWhite's
// pars/yardages, but its stroke indexes are remapped odd (old SI k → 2k−1): an
// 18-hole card needs an SI permutation of 1..18, and the remap preserves the
// front's difficulty order while leaving the even slots to the new back nine.
export const fixtureWhite18: TeeSet = {
  name: "white", rating: 71.6, slope: 128,
  holes: [
    { number: 1,  par: 4, yardage: 380, strokeIndex: 9 },
    { number: 2,  par: 4, yardage: 410, strokeIndex: 1 },
    { number: 3,  par: 3, yardage: 165, strokeIndex: 17 },
    { number: 4,  par: 5, yardage: 520, strokeIndex: 5 },
    { number: 5,  par: 4, yardage: 400, strokeIndex: 13 },
    { number: 6,  par: 3, yardage: 180, strokeIndex: 15 },
    { number: 7,  par: 4, yardage: 430, strokeIndex: 3 },
    { number: 8,  par: 5, yardage: 490, strokeIndex: 7 },
    { number: 9,  par: 4, yardage: 390, strokeIndex: 11 },
    { number: 10, par: 4, yardage: 410, strokeIndex: 2 },
    { number: 11, par: 3, yardage: 170, strokeIndex: 16 },
    { number: 12, par: 5, yardage: 530, strokeIndex: 8 },
    { number: 13, par: 4, yardage: 440, strokeIndex: 4 },
    { number: 14, par: 4, yardage: 385, strokeIndex: 12 },
    { number: 15, par: 5, yardage: 500, strokeIndex: 10 },
    { number: 16, par: 3, yardage: 155, strokeIndex: 18 },
    { number: 17, par: 4, yardage: 425, strokeIndex: 6 },
    { number: 18, par: 4, yardage: 395, strokeIndex: 14 },
  ],
};

export const fixtureLinks18: CourseCard = {
  courseName: "Fixture Links 18",
  teeSets: [fixtureWhite18],
};
