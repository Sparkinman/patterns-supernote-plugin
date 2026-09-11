import {
  MARK_SIZES,
  PX_PER_PEN_WIDTH,
  checkboxSideFor,
  penWidthForPx,
  rectHeight,
  rectWidth,
} from './types';
import type {GridSpec, Pt, RectPx, RenderedLine} from './types';

/**
 * Turning a rectangle and a spacing into marks on a page.
 *
 * **Every mark is a straight-line stroke**, including the dots, and that is
 * not a compromise. A stroke paints a round cap of half its own width past
 * each end — measured, and a nuisance everywhere else — so a stroke one pixel
 * long at `penWidth` N is a round dot N/100 pixels across. The alternative was
 * `GEO_circle`, which needs a centre and a radius and gives an outline rather
 * than a filled dot. A capped stub is the cheaper and better-behaved of the
 * two, and it keeps one code path for all three patterns.
 *
 * Nothing here knows about the device. `layoutGrid` is a pure function of the
 * request, which is what lets the preview and the real thing be drawn from the
 * same numbers instead of agreeing by coincidence.
 */

/**
 * How long one mark takes to draw, in milliseconds.
 *
 * Measured on an A6X2, and re-measured once the elements were being built
 * concurrently: 48 marks in 1,969ms, 120 in 4,759 and 460 in 17,312. Flat at
 * about 38ms, and **almost all of it is inside the host's own insert** — 37ms
 * an element there against 1.2ms to build one. Concurrency on the build side
 * bought 6% of the job and there is nothing else on this side of the bridge to
 * win.
 *
 * Which makes the only real lever *fewer elements for the same picture*. A 5mm
 * grid over a page is 560 dots or 44 ruled lines, and they cover the same
 * paper: twenty-one seconds against two.
 */
export const MS_PER_MARK = 38;

/**
 * The longest anybody should be asked to watch a panel not respond.
 *
 * Set so that the most ordinary request there is — a 5mm dot grid over a whole
 * page — fits on the larger panel too. That is 1,160 marks on an A5X2, or
 * about 49 seconds at the speed measured before the elements were built
 * concurrently. Refusing the obvious thing would be worse than the wait.
 *
 * This wants revisiting once probe 7 has reported what concurrency did to the
 * per-mark cost: if it halves, so should the number of seconds.
 */
export const MAX_DRAW_SECONDS = 60;

/**
 * The most marks that will be drawn in one go.
 *
 * **The limit is time, not failure.** Probe 7 asked for 460 marks and got 460
 * — nothing was dropped, the host stayed bound, the grid was even. It simply
 * took nineteen seconds. At 42ms each the old cap of 4,000 would have been
 * *two minutes and fifty seconds* of a panel apparently doing nothing, which
 * nobody would wait out; they would decide it had hung and start tapping.
 *
 * So the cap comes from the time budget above rather than from anything the
 * firmware refuses. A 5mm dot grid over a whole A6X2 page is about 560 marks,
 * or twenty-four seconds, and stays inside it.
 */
export const MAX_MARKS = Math.round((MAX_DRAW_SECONDS * 1000) / MS_PER_MARK);

/** Roughly how long a given number of marks will take, in seconds. */
export const estimateSeconds = (marks: number): number =>
  Math.max(1, Math.round((marks * MS_PER_MARK) / 1000));

/** The positions of the lattice, left to right and top to bottom. */
export function latticePoints(rect: RectPx, spacingPx: number): Pt[] {
  const {xs, ys} = latticeAxes(rect, spacingPx);
  const out: Pt[] = [];
  for (const y of ys) {
    for (const x of xs) {
      out.push({x, y});
    }
  }
  return out;
}

/**
 * Where the marks sit along each axis.
 *
 * Centred in the rectangle rather than started at its top-left corner. A grid
 * drawn from the corner leaves whatever the division happened not to use as a
 * gap down one side, which looks like a mistake; splitting the remainder puts
 * an equal margin on both sides and reads as deliberate.
 */
export function latticeAxes(
  rect: RectPx,
  spacingPx: number,
): {xs: number[]; ys: number[]} {
  const axis = (lo: number, hi: number): number[] => {
    const span = hi - lo;
    if (!(spacingPx > 0) || span < 0) {
      return [];
    }
    const count = Math.floor(span / spacingPx) + 1;
    const used = (count - 1) * spacingPx;
    const start = lo + (span - used) / 2;
    return Array.from({length: count}, (_, i) => Math.round(start + i * spacingPx));
  };

  return {
    xs: axis(rect.left, rect.right),
    ys: axis(rect.top, rect.bottom),
  };
}

/** How many marks a spec will draw, without building them. */
export function markCount(spec: GridSpec): number {
  const {xs, ys} = latticeAxes(spec.rect, spec.spacingPx);
  switch (spec.style.pattern) {
    case 'dots':
      return xs.length * ys.length;
    case 'crosses':
      return xs.length * ys.length * 2;
    case 'lines':
      // Horizontal rules only, and all of them — see `layoutGrid`.
      return ys.length;
    case 'squares':
      // Ruled lines, not marks per point: this is the cheap one by a long way.
      // The outermost line on each axis is skipped — see `layoutGrid`.
      return Math.max(0, xs.length - 2) + Math.max(0, ys.length - 2);
    case 'checklist':
      // Five strokes a row: four sides of the box, and the rule. The top
      // lattice position is not a row — see `layoutGrid`.
      return Math.max(0, ys.length - 1) * 5;
  }
}

/**
 * A dot: a stroke with nowhere to go.
 *
 * One pixel long, because a zero-length stroke is not worth finding out about
 * — two identical points may or may not be accepted, and the cap does the work
 * either way. The result is a round blob of `sizePx` across.
 */
function dotAt(p: Pt, penWidth: number, penColor: number, penType: number): RenderedLine {
  return {
    p1: {x: p.x, y: p.y},
    p2: {x: p.x + 1, y: p.y},
    penWidth,
    penColor,
    penType,
  };
}

export function layoutGrid(spec: GridSpec): RenderedLine[] {
  const {xs, ys} = latticeAxes(spec.rect, spec.spacingPx);
  const {penColor, penType, pattern, size} = spec.style;
  const sizePx = MARK_SIZES[size];
  const penWidth = penWidthForPx(sizePx);
  const out: RenderedLine[] = [];

  const cap = Math.floor((penWidth * PX_PER_PEN_WIDTH) / 2);

  if (pattern === 'lines') {
    /*
     * Ruled paper: horizontal rules and nothing else, for writing on.
     *
     * **Every rule is drawn, including the top and bottom one**, which is the
     * opposite of what `squares` does — and the difference is not an
     * inconsistency. Squares skips its outermost rules because the four of
     * them together make a frame around the region, and ruled paper has no
     * frame. A row of horizontals with no verticals cannot make a frame
     * whatever you do with it, so there is nothing to avoid, and every rule
     * here is a line somebody can write on.
     */
    for (const y of ys) {
      out.push({
        p1: {x: spec.rect.left + cap, y},
        p2: {x: spec.rect.right - cap, y},
        penWidth,
        penColor,
        penType,
      });
    }
    return out;
  }

  if (pattern === 'checklist') {
    /*
     * A to-do list: a rule to write on, and a box to tick at the left of it.
     *
     * **The topmost lattice position is not a row.** Every box stands on its
     * own rule and reaches upward into the row's writing space, so a rule
     * needs a clear spacing above it before it can carry one — and the first
     * position has only whatever the centring happened to leave, which can be
     * nothing at all. Drawing a rule there would either put a box outside the
     * region or leave one line conspicuously without a box. Dropping it costs
     * a row at most, and every row that is drawn is complete.
     *
     * That is also why the horizontal lattice is not used here. `xs` is a
     * spacing chosen for rows; where the box goes is set by the left edge and
     * by how big a box the row can hold.
     */
    const {left, right, top} = spec.rect;
    const side = checkboxSideFor(spec.spacingPx);
    // A clear channel between the box and the rule it sits on, so the two do
    // not read as one shape. A third of the box, and never less than the
    // stroke is thick.
    const gutter = Math.max(cap * 2, Math.round(side / 3));

    for (const y of ys.slice(1)) {
      const boxTop = Math.max(top, y - side);
      const boxRight = left + side;
      // The horizontals are drawn short by a cap at each end and the verticals
      // likewise, so the four painted strokes meet exactly at the corners
      // instead of overhanging them. The same correction the rules get.
      out.push({p1: {x: left + cap, y: boxTop}, p2: {x: boxRight - cap, y: boxTop}, penWidth, penColor, penType});
      out.push({p1: {x: left + cap, y}, p2: {x: boxRight - cap, y}, penWidth, penColor, penType});
      out.push({p1: {x: left, y: boxTop + cap}, p2: {x: left, y: y - cap}, penWidth, penColor, penType});
      out.push({p1: {x: boxRight, y: boxTop + cap}, p2: {x: boxRight, y: y - cap}, penWidth, penColor, penType});
      // The rule picks up after the gutter and runs to the edge, so the box
      // and the line share a baseline without touching.
      out.push({p1: {x: boxRight + gutter, y}, p2: {x: right - cap, y}, penWidth, penColor, penType});
    }
    return out;
  }

  if (pattern === 'squares') {
    /*
     * Interior rules only. **No border.**
     *
     * Drawing a line at every lattice position puts one along each edge, and
     * four of those are a frame around the whole thing — which is not what
     * ruled paper looks like and not what was asked for. Real graph paper has
     * no border; the ruling simply runs to the edge of the sheet and stops. So
     * the first and last position on each axis are skipped, and what is left
     * spans the full rectangle rather than the lattice, so the ruling reaches
     * the edge of the region on all four sides without outlining it.
     *
     * Each rule is still drawn short by half its own thickness at each end, so
     * the cap lands on the edge instead of past it. The same correction the
     * table plugin needed, for the same reason.
     */
    const {left, right, top, bottom} = spec.rect;
    for (const y of ys.slice(1, -1)) {
      out.push({p1: {x: left + cap, y}, p2: {x: right - cap, y}, penWidth, penColor, penType});
    }
    for (const x of xs.slice(1, -1)) {
      out.push({p1: {x, y: top + cap}, p2: {x, y: bottom - cap}, penWidth, penColor, penType});
    }
    return out;
  }

  /*
   * A cross is two stubs long enough to read as a cross rather than a fat
   * dot: a quarter of the spacing each way, so it scales with the grid and
   * never grows into its neighbour.
   */
  const arm = pattern === 'crosses' ? Math.max(2, Math.round(spec.spacingPx / 4)) : 0;

  for (const y of ys) {
    for (const x of xs) {
      if (pattern === 'dots') {
        out.push(dotAt({x, y}, penWidth, penColor, penType));
      } else {
        out.push({
          p1: {x: x - arm, y},
          p2: {x: x + arm, y},
          penWidth,
          penColor,
          penType,
        });
        out.push({
          p1: {x, y: y - arm},
          p2: {x, y: y + arm},
          penWidth,
          penColor,
          penType,
        });
      }
    }
  }
  return out;
}

export type FitResult =
  | {ok: true; spec: GridSpec; marks: number}
  | {ok: false; reason: string; marks: number};

/**
 * The one check between a person asking for a grid and it being drawn.
 *
 * Refuses rather than clamps. A grid that has quietly been given a different
 * spacing from the one that was asked for is worse than one that was not
 * drawn, because the numbers on the screen would no longer describe the page.
 */
export function fitGrid(spec: GridSpec): FitResult {
  const marks = markCount(spec);
  const {xs, ys} = latticeAxes(spec.rect, spec.spacingPx);

  if (rectWidth(spec.rect) <= 0 || rectHeight(spec.rect) <= 0) {
    return {ok: false, reason: 'That box has no area.', marks};
  }
  // Squares need three positions across to yield one interior rule, because
  // the outermost line on each axis is deliberately not drawn.
  const needed = spec.style.pattern === 'squares' ? 3 : 2;
  // Ruled lines and checklists only care about the vertical axis: a tall
  // narrow box is a perfectly good thing to rule, however few lattice columns
  // fit across it. A checklist needs two positions to yield one row, because
  // the topmost one is not a row.
  const rowsOnly = spec.style.pattern === 'lines' || spec.style.pattern === 'checklist';
  if (rowsOnly ? ys.length < 2 : xs.length < needed || ys.length < needed) {
    return {
      ok: false,
      reason: 'That spacing is too wide for the box. Choose a smaller spacing, or draw a bigger box.',
      marks,
    };
  }
  /*
   * A checklist needs room for the box and a line worth writing on beside it.
   * Below about three box widths what comes out is a column of boxes with a
   * stub attached, which is not what anybody drew the region for.
   */
  if (
    spec.style.pattern === 'checklist' &&
    rectWidth(spec.rect) < checkboxSideFor(spec.spacingPx) * 3
  ) {
    return {
      ok: false,
      reason: 'That box is too narrow for a checklist. Draw a wider box, or choose a smaller spacing.',
      marks,
    };
  }
  if (marks > MAX_MARKS) {
    return {
      ok: false,
      reason:
        `That would be ${marks.toLocaleString()} marks and take about ` +
        `${Math.round(estimateSeconds(marks) / 60)} minute${estimateSeconds(marks) >= 90 ? 's' : ''}. ` +
        'Use a wider spacing, a smaller box, or lines or squares — they need far fewer marks.',
      marks,
    };
  }
  return {ok: true, spec, marks};
}
