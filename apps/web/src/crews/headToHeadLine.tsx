import type { ReactNode } from "react";
import type { GolferId, HeadToHeadRecord } from "@swng/domain";
import { GolferLink } from "../ui/GolferLink";

// Head-to-head as a sentence, leader first — never the raw a/b row order. Extracted from
// SeasonPanel.tsx (its own home; the now-deleted CrewRecordsSection.tsx used to import this too,
// spec 2026-07-22 §4 — a season's own wide-dated window replaces the all-time surface, so this
// is SeasonPanel's alone again). Names are GolferLinks (the link sweep, task 6); the connective
// words/score/halves suffix stay plain text.
export const headToHeadLine = (h2h: HeadToHeadRecord, nameOf: (id: GolferId) => string): ReactNode => {
  const tied = h2h.aWins === h2h.bWins;
  const aLeads = h2h.aWins > h2h.bWins;
  const firstId = tied || aLeads ? h2h.a : h2h.b;
  const secondId = tied || aLeads ? h2h.b : h2h.a;
  const score = tied || aLeads ? `${h2h.aWins}–${h2h.bWins}` : `${h2h.bWins}–${h2h.aWins}`;
  return (
    <>
      <GolferLink golferId={firstId} name={nameOf(firstId)} />
      {tied ? " and " : " leads "}
      <GolferLink golferId={secondId} name={nameOf(secondId)} />
      {tied ? " are tied " : " "}
      {score}
      {h2h.halves > 0 && ` · ${h2h.halves} halved`}
    </>
  );
};
