// The canonical round designation (accounts-only identity spec §5, dated onto the played
// instant by round-played-date spec 2026-08-01 §6): a round is referred to everywhere — the home
// list, the archive page, the watch page, the join link's framing — as COURSE + DATE, "Casa Verde
// GC · Sat, Jul 12", with the tee time appended ("· 7:58a") only when two rounds share course AND
// day. A PURE function of facts the round already records (the frozen course card's name + WHEN
// THE GOLF HAPPENED, domain's playedAtMsOf): nothing is stored, no name field, no tags.
//
// Timezone is an EXPLICIT INPUT, never ambient. Pass `timeZone` (an IANA name like
// "America/New_York") to render the date and time in that zone; OMIT it to render in the
// environment's local zone, which is the product default — the viewer sees the round on the day
// the group actually played it (a Friday 7:00pm Pacific round reads "Fri", not the "Sat" its
// 02:00-UTC instant rolls over to, and the tee time reads on a clock the group recognizes). Purity
// is preserved by making the zone an argument rather than pinning UTC: both functions below stay
// deterministic functions of (facts, zone). `roundLabel` and `roundDayKey` MUST share a zone
// basis — the day the label prints is the same day the collision key groups on — so both take the
// same optional `timeZone`, with the same local default; a collision computed on one basis while
// the label renders on another would append the tee time to the wrong pairs.
//
// Formatted via Intl.DateTimeFormat pinned to the "en-US" locale (fixed English weekday/month
// names) with the timeZone threaded through, and assembled from `formatToParts` so the exact
// output shape is ours — no dependence on ICU's separator choices (e.g. the narrow-no-break-space
// it now emits before AM/PM).

export interface RoundDesignation {
  readonly courseName: string;
  // REQUIRED (round-played-date spec 2026-08-01 §6): WHEN THE GOLF HAPPENED — every round has
  // one, set at creation and correctable while live (domain's playedAtMsOf), so there is no
  // "no date" case left to tolerate. This REPLACES the old optional record-creation instant —
  // the two are different facts (product.md's own distinction: when the record was made vs.
  // when the golf happened), and the product only ever renders the latter.
  readonly playedAt: number;
}

export interface RoundLabelOptions {
  readonly withTime?: boolean;
  // IANA timezone name (e.g. "America/New_York"); when absent, the environment's local zone.
  readonly timeZone?: string;
}

export interface RoundDayKeyOptions {
  // The SAME explicit-input timezone contract as RoundLabelOptions — the two MUST agree (see the
  // module doc): the collision key groups rounds by day in this zone, local by default.
  readonly timeZone?: string;
}

const partValue = (parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";

// "Sat, Jul 12" — weekday + month + day in the given zone (local when timeZone is undefined).
const dayOf = (playedAt: number, timeZone?: string): string => {
  const parts = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone }).formatToParts(new Date(playedAt));
  return `${partValue(parts, "weekday")}, ${partValue(parts, "month")} ${partValue(parts, "day")}`;
};

// "7:58a" / "2:05p" / "12:00a" (midnight) / "12:00p" (noon) — a compact single-letter meridiem,
// built from parts so the AM/PM separator ICU inserts is dropped entirely.
const timeOf = (playedAt: number, timeZone?: string): string => {
  const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).formatToParts(new Date(playedAt));
  const meridiem = partValue(parts, "dayPeriod").toLowerCase().startsWith("p") ? "p" : "a";
  return `${partValue(parts, "hour")}:${partValue(parts, "minute")}${meridiem}`;
};

export const roundLabel = ({ courseName, playedAt }: RoundDesignation, { withTime, timeZone }: RoundLabelOptions = {}): string => {
  const base = `${courseName} · ${dayOf(playedAt, timeZone)}`;
  return withTime ? `${base} · ${timeOf(playedAt, timeZone)}` : base;
};

// The collision key a list uses to decide which rounds need the tee time (withTime): two rounds
// "collide" when they share BOTH course name and calendar day IN THE SAME ZONE as the label
// (local by default — see the module doc's zone-basis requirement). ALWAYS a string now —
// `playedAt` is required on every RoundDesignation (round-played-date spec 2026-08-01 §6), so
// every round has a day to be keyed on. The day is appended as `year-month-day` (zero-padded) so
// two rounds at the same course collide iff they fall on the same calendar day in that zone.
export const roundDayKey = ({ courseName, playedAt }: RoundDesignation, { timeZone }: RoundDayKeyOptions = {}): string => {
  const parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).formatToParts(new Date(playedAt));
  return `${courseName} ${partValue(parts, "year")}-${partValue(parts, "month")}-${partValue(parts, "day")}`;
};

// A predicate over a list: true for a designation that shares course+day with ANOTHER in the
// same list (so its roundLabel should render withTime to disambiguate — the "two indistinguishable
// Walker rounds" bug). Local-zone by default, same basis as roundLabel/roundDayKey. The ONE
// canonical in-list collision helper — HomePage and the crew "Played together" list both use it
// (spec 2026-07-22 §4).
export const dayCollisionChecker = (rounds: readonly RoundDesignation[], { timeZone }: RoundDayKeyOptions = {}): ((round: RoundDesignation) => boolean) => {
  const counts = new Map<string, number>();
  for (const round of rounds) {
    const key = roundDayKey(round, { timeZone });
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (round) => (counts.get(roundDayKey(round, { timeZone })) ?? 0) > 1;
};
