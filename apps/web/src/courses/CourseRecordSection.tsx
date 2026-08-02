import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { CourseId } from "@swng/domain";
import { formatOverPar, neverBirdiedPhrase, scoringHolePhrase, worstHolePhrase } from "@swng/domain";
import type { GetMyCourseRecordResponse } from "@swng/contracts";
import { getMyCourseRecord } from "../api";
import { useAuth } from "../auth/useAuth";
import { linkEntity } from "../ui/classes";

const INSIGHTS_MIN_ROUNDS = 5;

// "Your record here" (analytics read-folds spec 2026-07-21 §4): the caller's own rows at ONE
// course — signed-in only (CoursePage itself is a public, "none"-auth page, so this section gates
// itself rather than the whole page). Fetches on mount via the ignore-flag idiom
// (RoundRecordPage.tsx's own precedent — a stale-run guard against a courseId change or unmount
// racing a slow response). Renders nothing while loading, nothing signed-out, nothing at zero
// rounds (the record "shows from the 1st round" — spec §4 — so there is nothing to show before
// that).
export function CourseRecordSection({ courseId }: { readonly courseId: CourseId }) {
  const { withAuth, signedIn } = useAuth();
  const [record, setRecord] = useState<GetMyCourseRecordResponse | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!signedIn) return;
    let ignore = false;
    setRecord(undefined);
    setError(false);

    void withAuth((token) => getMyCourseRecord(token, courseId))
      .then((response) => {
        if (ignore) return;
        setRecord(response);
      })
      .catch(() => {
        if (ignore) return;
        setError(true);
      });

    return () => {
      ignore = true;
    };
  }, [signedIn, withAuth, courseId]);

  if (!signedIn) return null;
  if (error) {
    return <p className="text-oxblood">Could not load your record here — try again.</p>;
  }
  if (!record || record.rounds === 0) return null;

  const insights = record.insights;
  const hasHoleInsights = insights !== undefined && (insights.worstHole !== undefined || insights.scoringHole !== undefined || insights.neverBirdied !== undefined);

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-forest">Your record here</h2>
        <ul className="flex flex-col gap-1 text-sm text-fairway tabular-nums">
          <li>Rounds played — {record.rounds}</li>
          {/* best/scoringAverage split by hole count (round-plays-a-nine spec 2026-08-02, Finding
              1) — the profile's own "Best 18"/"Best 9" labelling (RecordSections.tsx), since a
              course can now hold both a nine and an eighteen and they must never mix. */}
          {record.best18 && (
            <li>
              Best 18 —{" "}
              <Link to={`/rounds/${record.best18.roundId}`} className={linkEntity}>
                {record.best18.gross} ({formatOverPar(record.best18.toPar)})
              </Link>
            </li>
          )}
          {record.best9 && (
            <li>
              Best 9 —{" "}
              <Link to={`/rounds/${record.best9.roundId}`} className={linkEntity}>
                {record.best9.gross} ({formatOverPar(record.best9.toPar)})
              </Link>
            </li>
          )}
          {record.scoringAverage18 !== undefined && <li>Scoring average (18) — {record.scoringAverage18.toFixed(1)}</li>}
          {record.scoringAverage9 !== undefined && <li>Scoring average (9) — {record.scoringAverage9.toFixed(1)}</li>}
        </ul>
      </div>

      {/* "The holes, by name" (spec §4): gated at ≥5 rounds AT THIS COURSE — the domain owns the
          gate (`insights` is undefined below it), never re-derived here. The gate copy mirrors
          IndexOverTime's own "shows up at N rounds" idiom. */}
      {insights === undefined ? (
        <p className="text-sm text-fairway">
          Your course record builds at {INSIGHTS_MIN_ROUNDS} rounds here — you've played {record.rounds}.
        </p>
      ) : (
        hasHoleInsights && (
          <div>
            <h3 className="text-base font-semibold">The holes, by name</h3>
            <ul className="flex flex-col gap-1 text-sm text-fairway">
              {insights.worstHole && <li>{worstHolePhrase(insights.worstHole)}</li>}
              {insights.scoringHole && <li>{scoringHolePhrase(insights.scoringHole)}</li>}
              {insights.neverBirdied && <li>{neverBirdiedPhrase(insights.neverBirdied)}</li>}
            </ul>
          </div>
        )
      )}
    </section>
  );
}
