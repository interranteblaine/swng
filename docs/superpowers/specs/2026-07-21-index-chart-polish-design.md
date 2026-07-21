# The index chart, finished — a windowed, scaled, honest plot

> Status: **owner-approved design** (2026-07-21, via rendered mockup — artifact
> `117821fb`, panels B and D — after the owner's field report: "the trend graph isn't
> polished"). This is the record-redesign arc's own riding note un-accepted: the shipped
> "index over time" chart was a compact sparkline with no axis, no padding, no window,
> and a fixed 280px width. The redesign made the DATA right (two lines, per-round index
> recompute, the 8-round gate); this arc makes the DRAWING right. Everything here is
> presentation plus one additive optional wire field; no stored shape changes, nothing
> sealed is touched.

## 1. The model (binding)

### 1.1 The window: your last 20 rounds

The chart draws at most the golfer's **last 20 rounds** — the WHS window (Rule 5.2a
computes the index from the best 8 of the last 20), so the plot shows exactly the run of
rounds the number at the end of the line was built from. This is a **presentation
window**: a `slice(-20)` in the web component beside the existing 8-round gate constant
(`INDEX_CHART_WINDOW = 20` next to `INDEX_HISTORY_MIN_ROUNDS = 8`). Slicing is honest by
construction — every `IndexPoint` already folds the whole career before it, so dropping
older points from view changes no drawn value; round 21 pushes the oldest point off the
left edge. The wire keeps serving full `indexHistory` (the history list below remains the
complete record). The header meta stays literally true: "your/their last {drawn}
round(s)" where drawn = min(total, 20).

Rejected windows (owner-ratified): **last month** (under our own 8-round noise gate for
nearly everyone), **last year** (density becomes golfer-dependent — 150 points for a
retiree, 6 for a casual player — needing downsampling to rescue an arbitrary window),
**all time** (a 300-round career at per-round spacing is unreadable at phone width; a
real career view is a future, dedicated surface — see §3), and a **range picker** (the
record-redesign ruling stands: the chart is data, "no choice — just data"; choice
affordances belong on the claim, i.e. the index source picker).

### 1.2 Scale honesty: nice bounds, minimum span

Y-bounds are computed from the DRAWN points only, exactly:

1. `lo = min(values)`, `hi = max(values)` over every drawn swng/WHS value.
2. If `hi − lo < 4`, expand symmetrically about the midpoint to a span of 4 — the
   **minimum-span rule**: a steady season must LOOK steady (the same
   refusing-to-draw-noise principle as the 8-round gate; today's min–max stretch
   amplifies a 0.7-point wiggle to full plot height).
3. `lo = floor(lo)`, `hi = ceil(hi)` — whole-index bounds. A value landing exactly on a
   whole number sits ON its gridline — normal chart behavior (a baseline, not a frame);
   what the insets guarantee (§1.3) is that no marker is ever clipped and nothing draws
   on a border, the shipped defect.

Ticks at whole index values: step 1 when the span ≤ 4, step 2 when ≤ 8, else step 5
(3–5 ticks always); ticks run from `ceil(lo/step)*step` up to `hi`. Every tick draws a
full-width hairline gridline (`--color-hairline`) and a mono 11px label in the left
gutter. **Tick labels render through the domain's integer plus-convention formatter
`formatCourseHandicap`** — a tick below scratch reads `+2`, never `-2`; the whole-tree
grep gate (no bare signed index render in `apps/web/src`) applies to the axis with no
carve-out. The call site comments that `formatCourseHandicap` is being reused as the
model's ONE "signed whole golf number" formatter, not because a tick is a course
handicap.

### 1.3 Geometry: no frame, inset plot, emphasized endpoints

- The `cardBox` border on the SVG is **deleted** — faint gridlines on the paper
  structure the plot; there is no box.
- The plot area is inset from the SVG: left gutter 30px (tick labels), right 12px, top
  10px, bottom 24px (date anchors). No marker is ever clipped.
- Markers stay r=2.5 (swng ● filled forest; WHS ○ hollow fairway) — but hollow WHS
  markers are **filled with the page cream** so gridlines don't pass through them.
- Each series' **latest point draws at r=4** — it is the number the caption names.
- Unchanged laws: the same point index maps to the same x whichever series it belongs
  to; a lower index sits lower on screen; a single-vertex series still shows its dot.

### 1.4 Fluid width, fixed height

The SVG renders at its **container's measured width** (a new ~20-line
`useContainerWidth` hook — ResizeObserver, no library; fallback 320 when ResizeObserver
is unavailable, e.g. happy-dom; clamp to a 260 minimum), **height fixed at 150**.
Coordinates are computed at CSS-pixel scale — ticks, dots, and stroke weights never
scale with the container. The chart's container is capped at `max-w-xl` so an ultrawide
desktop doesn't stretch the line into a flat wire. Width is driven by the container,
never by the data — more points pack tighter inside the same plot (which is what the
20-round window bounds).

### 1.5 One caption line

The separate legend row (`● swng   ○ WHS`) is deleted. One line below the chart is
legend AND current values: `● swng 1.2 · ○ WHS 0.2` — values through
`formatHandicapIndex`, `—` when a series has no value (existing behavior).

### 1.6 Date anchors — and the ONE wire change

The first and last DRAWN rounds' dates render at the baseline corners, mono 11px
(`May 12` … `Jul 21`): "over time" finally says which time. Format: local-time
`MMM d`; when the two anchors fall in different calendar years, both gain `, yyyy`.
The date of a point is `createdAt ?? finalizedAt` (the played date first — home's own
`roundLabel` preference), joined from the same response's `history` by `roundId` (the
bests/milestones join precedent; history is newest-first, indexHistory oldest-first —
the id join is order-independent). If either anchor's date is unavailable, the anchors
are omitted and the layout is otherwise unchanged.

The wire change: **record history rows gain OPTIONAL `finalizedAt` and `createdAt`** —
`GET /me/record` and `GET /golfers/{golferId}`, whose shared `recordOf`/`toWireLine`
currently strips the projection store's `finalizedAtMs`/`createdAtMs`. Same fields, same
rename discipline as `GET /me/rounds` (`finalizedAtMs` → wire `finalizedAt`). Optional
on the schema so a new bundle against an old lambda parses clean (anchors just don't
draw); always served in practice (every store row holds `finalizedAtMs`). Deploy is
lambda-first regardless (standing precedent).

### 1.7 Unchanged, explicitly

The 8-round gate and its copy; the heading + `person` ("your"/"their") copy; "swng
covers every round / WHS holds flat across unrated" semantics; the `index-chart` /
`index-line-*` / `index-dot-*` testids; the ESLint compute fence (chart geometry —
bounds, ticks, coordinates — is presentation math and lives in the web; the only domain
imports are the fence-allowed presentation formatters `formatHandicapIndex` and
`formatCourseHandicap`).

## 2. Out of scope (recorded)

- **All-time career view** — a legitimate future want; a dedicated, wider surface
  (probably time-scaled x), never a toggle on this glance card.
- **Time-scaled x on THIS chart** — per-round ordinal stands: the index steps only when
  you play; time-scaling clusters weekend rounds into overlapping dots and spends plot
  width on empty winters. The date anchors are what keep ordinal honest.
- On-chart value labels (redundant with the caption; near endpoints they collide),
  hover/touch tooltips, a y-axis title, dark theme (the product is light-only).

## 3. Testing

- **Component (RecordSections.test.tsx + page tests):** a 25-point history draws 20
  vertices and the header reads "your last 20 rounds"; a quiet season (drawn span < 4)
  gets the expanded min-span bounds (assert via tick labels, not pixel math); a domain
  crossing scratch renders a `+` tick label and no bare `-N` tick; gridline count equals
  tick count; the SVG carries no border class; each series' last dot is larger than its
  others; the caption line matches `● swng … · ○ WHS …`; date anchors render from
  `createdAt ?? finalizedAt` and are omitted when dates are absent; fallback width
  applies under happy-dom. Existing testids keep their meaning (gate tests unchanged).
- **Contracts/application:** `toWireLine` passes `finalizedAt`/`createdAt` through;
  both response schemas accept rows with and without them (old-lambda tolerance pinned).
- **E2E reconciliation (its own task — the string-breakage law):** sweep e2e for chart
  locators and copy; as of this writing no e2e spec locks chart DOM or the legend row,
  and the unit-test vertex pins use ≤10-round fixtures (under the window) — verify, don't
  assume.
- **Close-out (controller-run):** `deploy:beta` LAMBDA-FIRST → `publish:web:beta` →
  `e2e:beta` ×2 → `e2e:field` → a browser walk on deployed beta.swng.golf reading the
  live chart: ticks with values, gridlines, date anchors, no clipped markers, caption
  line, at phone width. NO wipe (additive optional wire only).
