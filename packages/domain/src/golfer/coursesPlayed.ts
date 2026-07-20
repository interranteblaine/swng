// One line's worth of what coursesPlayed needs to group by course — deliberately structural
// (plain `string`, not `CourseId`/`GolferRoundLine`) so a wire line (GetMyRoundsResponse's own
// `rounds`) passes straight in with no conversion step, the `gameMembers` precedent: a
// derivation over round lines is domain truth, never inline view logic.
export interface CoursesPlayedLine {
  readonly courseId?: string;
  readonly courseName: string;
}

export interface CoursePlayed {
  readonly courseId: string;
  readonly name: string;
  readonly rounds: number;
}

// Folds a golfer's round lines into one row per distinct course, with a round count. Lines
// without a courseId (pre-course-cards archives, spec §4 — recorded from day one but absent on
// old data) are skipped, since there is nothing to link to. `lines` arrives newest-first (GET
// /me/rounds' own order — see GetMyRoundsResponse's doc comment); the output preserves
// FIRST-SEEN order, which is therefore already most-recent-first — no separate sort.
export const coursesPlayed = (lines: readonly CoursesPlayedLine[]): readonly CoursePlayed[] => {
  const order: string[] = [];
  const byId = new Map<string, CoursePlayed>();
  for (const line of lines) {
    if (!line.courseId) continue;
    const existing = byId.get(line.courseId);
    if (existing) {
      byId.set(line.courseId, { ...existing, rounds: existing.rounds + 1 });
    } else {
      order.push(line.courseId);
      byId.set(line.courseId, { courseId: line.courseId, name: line.courseName, rounds: 1 });
    }
  }
  return order.map((id) => byId.get(id)!);
};
