import type { GolferId, RoundState } from "@swng/domain";
import { ApplicationError } from "./errors.js";

// The seam architecture.md promises ("an explicit ScoringPolicy on the round says who may
// score for whom") — v1 ships its one member, trivially satisfied: anyone in the group may
// record for anyone else in the group, matching how a real card gets kept. Growing the menu
// (e.g. a future "captain-only" policy) is a new union member plus a new switch arm, never a
// call-site rewrite.
export type ScoringPolicy = { readonly kind: "anyone-in-group" };

// Shared by mayScore below and every claims-taking use case's "is this golfer actually in
// the round" guard — pulled out once so the five use cases can't drift on how membership is
// decided (conventions §0).
export const isParticipant = (state: RoundState, golfer: GolferId): boolean => state.participants.some((participant) => participant.golferId === golfer);

// The generic guard every claims-taking use case (AddGame, RecordScore, FinalizeRound)
// opens with (M3 plan: "claims golfer not a participant -> not-a-participant") — pulled
// out so the three call sites share one implementation of "is this token's owner actually
// in the round" rather than three copies of the same throw.
export const requireParticipant = (state: RoundState, golfer: GolferId): void => {
  if (!isParticipant(state, golfer)) throw new ApplicationError("not-a-participant");
};

export const mayScore = (policy: ScoringPolicy, state: RoundState, author: GolferId, subject: GolferId): boolean => {
  switch (policy.kind) {
    case "anyone-in-group":
      return isParticipant(state, author) && isParticipant(state, subject);
  }
};
