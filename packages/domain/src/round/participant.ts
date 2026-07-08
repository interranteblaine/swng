import type { GolferId } from "../ids.js";

export interface Participant {
  readonly golferId: GolferId;
  readonly name: string;
  readonly tee: string;            // TeeSet name within the round's frozen CourseCard
  readonly courseHandicap: number; // frozen at join; negative = plus handicap
}
